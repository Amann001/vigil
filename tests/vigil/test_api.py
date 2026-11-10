import json

import pytest
from fastapi.testclient import TestClient

from vigil.api import create_app

TOKEN = "test-token"
REPORT = {
    "id": "live-1",
    "status": "awaiting review",
    "alert_at": "2026-11-08T07:52:15+00:00",
    "diagnosis": {
        "root_cause_service": "payments",
        "category": "slow_responses",
        "confidence": "high",
    },
    "proposal": {"action": "escalate", "service": None},
}


class FakeQueue:
    def __init__(self):
        self.queued = []

    def enqueue(self, kind, payload, key=None, max_attempts=3):
        if any(k == key for _, _, k in self.queued):
            return None
        self.queued.append((kind, payload, key))
        return len(self.queued)

    def counts(self):
        return {"queued": len(self.queued)}

    def jobs(self, limit=50):
        return [{"kind": kind, "key": key} for kind, _, key in self.queued]


@pytest.fixture
def setup(tmp_path):
    (tmp_path / "live-1.json").write_text(json.dumps(REPORT))
    (tmp_path / "live-1.md").write_text("# Incident report")
    (tmp_path / "audit.jsonl").write_text(json.dumps({"outcome": "executed"}) + "\n")
    queue = FakeQueue()
    app = create_app(queue, TOKEN, reports_dir=tmp_path, audit_log=tmp_path / "audit.jsonl")
    return TestClient(app), queue


AUTH = {"Authorization": f"Bearer {TOKEN}"}
RESTART = {"verdict": "corrected", "notes": "payments itself is slow", "restart": "payments"}


def test_investigations_can_be_listed_and_read(setup):
    client, _ = setup

    (summary,) = client.get("/investigations").json()
    full = client.get("/investigations/live-1").json()

    assert summary["root_cause_service"] == "payments" and summary["status"] == "awaiting review"
    assert full["incident_report"] == "# Incident report"
    assert client.get("/investigations/nope").status_code == 404


def test_a_review_is_queued_for_a_worker(setup):
    client, queue = setup

    reply = client.post("/investigations/live-1/review", json=RESTART, headers=AUTH)

    assert reply.status_code == 202
    ((kind, payload, key),) = queue.queued
    assert kind == "review" and key == "review:live-1"
    assert payload["instead"] == {"action": "restart_service", "service": "payments"}
    again = client.post("/investigations/live-1/review", json=RESTART, headers=AUTH)
    assert again.status_code == 409  # one review per investigation


def test_reviews_need_the_token(setup):
    client, queue = setup

    missing = client.post("/investigations/live-1/review", json=RESTART)
    wrong = client.post(
        "/investigations/live-1/review", json=RESTART, headers={"Authorization": "Bearer guess"}
    )

    assert (missing.status_code, wrong.status_code) == (401, 401)
    assert queue.queued == []


def test_reviews_are_off_without_a_configured_token(tmp_path):
    (tmp_path / "live-1.json").write_text(json.dumps(REPORT))
    client = TestClient(create_app(FakeQueue(), token=None, reports_dir=tmp_path))

    reply = client.post("/investigations/live-1/review", json=RESTART, headers=AUTH)

    assert reply.status_code == 403


def test_only_known_services_can_be_restarted(setup):
    client, queue = setup

    reply = client.post(
        "/investigations/live-1/review", json=RESTART | {"restart": "prometheus"}, headers=AUTH
    )

    assert reply.status_code == 422 and queue.queued == []


def test_a_finished_investigation_cannot_be_reviewed_again(setup, tmp_path):
    client, _ = setup
    (tmp_path / "live-1.json").write_text(json.dumps(REPORT | {"status": "confirmed"}))

    reply = client.post("/investigations/live-1/review", json=RESTART, headers=AUTH)

    assert reply.status_code == 409


def test_queue_and_audit_are_readable(setup):
    client, _ = setup

    assert client.get("/health").json() == {"status": "ok", "queue": True}
    assert client.get("/audit").json() == [{"outcome": "executed"}]
    assert client.get("/jobs").json()["counts"] == {"queued": 0}


def test_a_running_investigation_is_listed_and_readable_before_its_report_exists(tmp_path):
    live = tmp_path / "live"
    live.mkdir()
    running = {"id": "live-2", "status": "investigating", "alert_at": "2026-11-11T10:00:00+00:00"}
    (live / "live-2.json").write_text(json.dumps(running | {"events": [{"step": "plan"}]}))
    client = TestClient(create_app(reports_dir=tmp_path))

    (listed,) = client.get("/investigations").json()
    (now,) = client.get("/live").json()
    full = client.get("/investigations/live-2").json()

    assert listed["status"] == "investigating" and now["id"] == "live-2"
    assert full["events"] == [{"step": "plan"}]


def test_the_system_view_is_offline_without_prometheus(tmp_path):
    client = TestClient(create_app(reports_dir=tmp_path))

    assert client.get("/system").json() == {"online": False}


def test_breaking_a_service_from_the_ui_needs_the_token(tmp_path):
    calls = []
    app = create_app(
        token=TOKEN, reports_dir=tmp_path, chaos=lambda s, r: calls.append((s, r)) or {"ok": 1}
    )
    client = TestClient(app)

    refused = client.post("/chaos/payments", json={"fault": "crash"})
    done = client.post("/chaos/payments", json={"fault": "crash"}, headers=AUTH)
    cleared = client.delete("/chaos/payments", headers=AUTH)
    unknown = client.post("/chaos/prometheus", json={"fault": "crash"}, headers=AUTH)

    assert refused.status_code == 401 and done.status_code == 200
    assert cleared.status_code == 200 and unknown.status_code == 422
    faults = [(s, r.fault if r else None) for s, r in calls]
    assert faults == [("payments", "crash"), ("payments", None)]


def test_the_built_ui_is_served_without_hiding_the_api(tmp_path):
    ui = tmp_path / "dist"
    ui.mkdir()
    (ui / "index.html").write_text("<title>Vigil</title>")
    client = TestClient(create_app(reports_dir=tmp_path, ui_dir=ui))

    assert "Vigil" in client.get("/").text
    assert client.get("/health").json()["status"] == "ok"


def test_a_timeline_left_behind_by_a_stopped_worker_is_shown_as_stopped(tmp_path):
    import os
    import time

    from vigil.api import STALE_SECONDS

    live = tmp_path / "live"
    live.mkdir()
    path = live / "live-3.json"
    path.write_text(json.dumps({"id": "live-3", "status": "investigating", "alert_at": "x"}))
    old = time.time() - STALE_SECONDS - 60
    os.utime(path, (old, old))
    client = TestClient(create_app(reports_dir=tmp_path))

    assert client.get("/live").json() == []
    assert client.get("/investigations/live-3").json()["status"] == "failed"

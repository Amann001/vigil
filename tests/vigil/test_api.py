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

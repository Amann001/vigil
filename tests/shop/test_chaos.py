import json
import logging
import time

import pytest
from fastapi.testclient import TestClient

from shop.chaos import (
    CHAOS_PATH,
    CRASH_EXIT_CODE,
    OOM_EXIT_CODE,
    FaultRequest,
    LedgerEntry,
    record,
)
from shop.jsonlog import JsonFormatter
from shop.service import create_service

# Words that would give the injected fault away to an agent reading logs or metrics.
GIVEAWAYS = ("chaos", "fault", "inject", "leak")


def make_app():
    app = create_service("testsvc")

    @app.get("/work")
    async def work() -> dict[str, str]:
        return {"done": "yes"}

    return app


def duration_sum(metrics: str) -> float:
    for line in metrics.splitlines():
        if line.startswith('http_request_duration_seconds_sum{method="GET",route="/work"'):
            return float(line.split()[-1])
    return 0.0


def test_no_fault_by_default():
    client = TestClient(make_app())

    assert client.get(CHAOS_PATH).json()["fault"] is None
    assert client.get("/work").status_code == 200


def test_latency_fault_slows_requests_and_is_measured():
    client = TestClient(make_app())
    before = duration_sum(client.get("/metrics").text)
    client.post(CHAOS_PATH, json={"fault": "latency", "latency_seconds": 0.2})

    start = time.perf_counter()
    client.get("/work")
    elapsed = time.perf_counter() - start

    assert elapsed >= 0.15  # 0.2s with +/-20% jitter
    assert duration_sum(client.get("/metrics").text) - before >= 0.15


def test_health_and_metrics_are_never_slowed():
    client = TestClient(make_app())
    client.post(CHAOS_PATH, json={"fault": "latency", "latency_seconds": 2})

    start = time.perf_counter()
    client.get("/health")
    client.get("/metrics")

    assert time.perf_counter() - start < 0.5


def test_error_fault_returns_500_with_a_realistic_log(caplog):
    client = TestClient(make_app())
    client.post(CHAOS_PATH, json={"fault": "errors", "error_rate": 1.0})

    with caplog.at_level(logging.INFO):
        response = client.get("/work")

    assert response.status_code == 500
    messages = [r.getMessage() for r in caplog.records]
    assert "connection pool exhausted" in messages
    completed = next(r for r in caplog.records if r.getMessage() == "request completed")
    assert completed.status == 500


def test_partial_error_rate():
    app = make_app()
    client = TestClient(app)
    app.state.chaos.rng.seed(3)
    client.post(CHAOS_PATH, json={"fault": "errors", "error_rate": 0.3})

    failures = sum(client.get("/work").status_code == 500 for _ in range(300))

    assert 60 <= failures <= 120  # ~90 expected


def test_nothing_agents_can_see_names_the_fault(caplog):
    client = TestClient(make_app())
    formatter = JsonFormatter("testsvc")

    with caplog.at_level(logging.DEBUG):
        client.post(CHAOS_PATH, json={"fault": "errors", "error_rate": 1.0})
        for _ in range(5):
            client.get("/work")
        client.get(CHAOS_PATH)
        client.delete(CHAOS_PATH)
        client.post(CHAOS_PATH, json={"fault": "latency", "latency_seconds": 0.01})
        client.get("/work")

    # Only the service's own log lines: the test client's httpx lines never reach service logs.
    service_records = [r for r in caplog.records if r.name.startswith("shop.")]
    assert service_records
    logs = "\n".join(formatter.format(record) for record in service_records).lower()
    metrics = client.get("/metrics").text.lower()
    for word in GIVEAWAYS:
        assert word not in logs, word
        assert word not in metrics, word


def test_fault_expires_after_its_duration():
    client = TestClient(make_app())
    client.post(CHAOS_PATH, json={"fault": "errors", "error_rate": 1.0, "duration_seconds": 0.2})
    assert client.get("/work").status_code == 500

    time.sleep(0.3)

    assert client.get("/work").status_code == 200
    assert client.get(CHAOS_PATH).json()["fault"] is None


def test_clear_stops_the_fault():
    client = TestClient(make_app())
    client.post(CHAOS_PATH, json={"fault": "errors", "error_rate": 1.0})

    client.delete(CHAOS_PATH)

    assert client.get("/work").status_code == 200


def test_leak_grows_memory_and_ends_in_oom_kill():
    app = make_app()
    exits: list[int] = []
    app.state.chaos.exit = exits.append

    with TestClient(app) as client:
        client.post(
            CHAOS_PATH,
            json={"fault": "leak", "leak_mb_per_second": 20, "leak_limit_mb": 50},
        )
        for _ in range(60):
            if exits:
                break
            time.sleep(0.1)
        leaked = app.state.chaos.leaked_mb

    assert exits == [OOM_EXIT_CODE]
    assert leaked >= 50


def test_clearing_a_leak_frees_the_memory():
    app = make_app()
    app.state.chaos.exit = lambda code: None

    with TestClient(app) as client:
        client.post(CHAOS_PATH, json={"fault": "leak", "leak_mb_per_second": 20})
        time.sleep(1.5)
        assert app.state.chaos.leaked_mb > 0
        client.delete(CHAOS_PATH)

    assert app.state.chaos.leaked_mb == 0


def test_crash_exits_the_process():
    app = make_app()
    exits: list[int] = []
    app.state.chaos.exit = exits.append

    with TestClient(app) as client:
        assert client.post(CHAOS_PATH, json={"fault": "crash"}).status_code == 200
        time.sleep(0.3)

    assert exits == [CRASH_EXIT_CODE]


@pytest.mark.parametrize(
    "body",
    [
        {"fault": "meteor"},
        {"fault": "errors", "error_rate": 0},
        {"fault": "latency", "latency_seconds": -1},
        {"fault": "leak", "leak_mb_per_second": 1000},
    ],
)
def test_invalid_faults_are_rejected(body):
    assert TestClient(make_app()).post(CHAOS_PATH, json=body).status_code == 422


def test_process_memory_is_exported():
    metrics = TestClient(make_app()).get("/metrics").text

    lines = metrics.splitlines()
    rss = next(line for line in lines if line.startswith("process_resident_memory_bytes "))
    assert float(rss.split()[-1]) > 10_000_000
    assert "process_cpu_seconds_total " in metrics


@pytest.mark.parametrize(
    ("fault", "keys"),
    [
        ("latency", {"fault", "latency_seconds", "duration_seconds"}),
        ("errors", {"fault", "error_rate", "duration_seconds"}),
        ("leak", {"fault", "leak_mb_per_second", "leak_limit_mb", "duration_seconds"}),
        ("crash", {"fault", "duration_seconds"}),
    ],
)
def test_summary_keeps_only_relevant_settings(fault, keys):
    assert set(FaultRequest(fault=fault).summary()) == keys


def test_ledger_records_ground_truth(tmp_path):
    ledger = tmp_path / "ledger.jsonl"

    record(LedgerEntry("2026-11-04T00:00:00Z", "inject", "payments", {"fault": "crash"}), ledger)
    record(LedgerEntry("2026-11-04T00:05:00Z", "clear", "payments", None), ledger)

    entries = [json.loads(line) for line in ledger.read_text().splitlines()]
    assert [e["action"] for e in entries] == ["inject", "clear"]
    assert entries[0]["service"] == "payments"
    assert entries[0]["fault"] == {"fault": "crash"}

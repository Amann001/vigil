"""Queue tests run against a real Postgres: SKIP LOCKED and leases cannot be faked honestly.

CI provides a throwaway Postgres; locally, point VIGIL_TEST_DATABASE_URL at any database. Each
test gets its own schema, dropped afterwards, so nothing else in the database is touched.
"""

import os
import threading
import time
import uuid

import pytest

from vigil.db import connect
from vigil.queue import BACKOFF_SECONDS, Queue

URL = os.environ.get("VIGIL_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="set VIGIL_TEST_DATABASE_URL to run queue tests")


@pytest.fixture
def schema():
    name = f"test_{uuid.uuid4().hex[:12]}"
    yield name
    with connect(URL) as connection:
        connection.execute(f"drop schema if exists {name} cascade")


@pytest.fixture
def queue(schema):
    queue = Queue(URL, schema)
    yield queue
    queue.close()


def test_a_job_is_claimed_once_and_completed(queue):
    job_id = queue.enqueue("investigate", {"alert": "a"}, key="alert-1")

    job = queue.claim("worker-a")

    assert job.id == job_id and job.payload == {"alert": "a"} and job.attempts == 1
    assert queue.claim("worker-b") is None
    assert queue.complete(job, "worker-a", {"diagnosis": "payments"})
    assert queue.counts() == {"done": 1}


def test_the_same_alert_is_never_queued_twice(queue):
    assert queue.enqueue("investigate", {}, key="alert-1") is not None
    assert queue.enqueue("investigate", {}, key="alert-1") is None


def test_concurrent_workers_never_share_a_job(queue, schema):
    for number in range(20):
        queue.enqueue("investigate", {"n": number})
    claimed, lock = [], threading.Lock()

    def work(name):
        own = Queue(URL, schema)  # each worker has its own connection, as separate processes do
        while (job := own.claim(name)) is not None:
            with lock:
                claimed.append(job.id)
            own.complete(job, name)
        own.close()

    threads = [threading.Thread(target=work, args=(f"worker-{i}",)) for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(claimed) == 20 and len(set(claimed)) == 20
    assert queue.counts() == {"done": 20}


def test_a_dead_workers_job_is_reclaimed_after_its_lease(queue):
    """The crash-recovery path: worker-a stops renewing its lease (it died)."""
    queue.enqueue("investigate", {})
    job = queue.claim("worker-a", lease_seconds=1)
    assert queue.claim("worker-b") is None  # still leased

    time.sleep(1.5)
    reclaimed = queue.claim("worker-b")

    assert reclaimed.id == job.id and reclaimed.attempts == 2
    assert not queue.heartbeat(job, "worker-a")  # the old worker has lost it
    assert not queue.complete(job, "worker-a")
    assert queue.complete(reclaimed, "worker-b")


def test_a_heartbeat_keeps_the_job(queue):
    queue.enqueue("investigate", {})
    job = queue.claim("worker-a", lease_seconds=1)

    time.sleep(0.6)
    assert queue.heartbeat(job, "worker-a", lease_seconds=1)
    time.sleep(0.6)

    assert queue.claim("worker-b") is None


def test_a_failed_job_is_retried_later_then_given_up(queue):
    queue.enqueue("investigate", {}, max_attempts=2)

    first = queue.claim("worker-a")
    assert queue.fail(first, "worker-a", "rate limited") == "queued"
    assert queue.claim("worker-a") is None  # backing off for BACKOFF_SECONDS

    queue.connection.execute(f"update {queue.table} set run_after = now()")  # skip the wait
    second = queue.claim("worker-a")
    assert second.attempts == 2
    assert queue.fail(second, "worker-a", "rate limited again") == "failed"
    (row,) = queue.jobs()
    assert row["status"] == "failed" and row["last_error"] == "rate limited again"
    assert BACKOFF_SECONDS > 0


def test_a_job_whose_worker_died_on_the_last_attempt_is_given_up(queue):
    queue.enqueue("investigate", {}, max_attempts=1)
    queue.claim("worker-a", lease_seconds=1)
    time.sleep(1.5)

    assert queue.claim("worker-b") is None
    (row,) = queue.jobs()
    assert row["status"] == "failed" and "last attempt" in row["last_error"]


def test_a_worker_runs_a_job_and_records_its_result(queue, schema):
    from vigil.worker import run_once

    queue.enqueue("investigate", {"id": "incident-1"})
    seen = []

    job = run_once(queue, queue, "worker-a", {"investigate": lambda p: seen.append(p) or {"ok": 1}})

    assert seen == [{"id": "incident-1"}]
    assert job.kind == "investigate" and queue.counts() == {"done": 1}
    assert run_once(queue, queue, "worker-a", {}) is None  # nothing left


def test_a_job_that_raises_is_queued_again_with_its_error(queue):
    from vigil.worker import run_once

    queue.enqueue("investigate", {"id": "incident-1"})

    def rate_limited(payload):
        raise RuntimeError("Every diagnosis model failed")

    run_once(queue, queue, "worker-a", {"investigate": rate_limited})

    (row,) = queue.jobs()
    assert row["status"] == "queued" and "Every diagnosis model failed" in row["last_error"]


def test_enqueueing_the_same_investigation_twice_queues_it_once(queue):
    import pandas as pd

    from vigil.alerts import Alert, Signal
    from vigil.worker import enqueue_investigation

    alert = Alert(pd.Timestamp("2026-11-08T12:00:00Z"), (Signal("payments.up", 0, 1, 1000),))

    first = enqueue_investigation(queue, "live-1", alert, alert.detected_at, mode="live")
    again = enqueue_investigation(queue, "live-1", alert, alert.detected_at, mode="live")

    assert first is not None and again is None
    assert queue.claim("worker-a").payload["alert"] == alert.to_dict()

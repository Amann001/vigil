"""A worker: takes jobs from the queue and runs them, renewing each job's lease while it works.

Jobs:
- investigate: {"id", "alert", "as_of", "mode": "live" | "replay", "dataset"}. Runs the
  investigation until it awaits review. Evidence is fixed at `as_of`, so a retried or reclaimed
  job sees the same moment as the first attempt.
- review: {"id", "verdict", "notes", "approve", "by", "instead"}. Records the decision, runs an
  approved fix, writes the report and remembers the incident.

If the worker dies, its lease runs out and another worker (or this one, restarted) reclaims
the job; the investigation then continues from its last checkpoint.

Run one with: uv run vigil worker
"""

import os
import socket
import threading
import time
from collections.abc import Callable
from pathlib import Path

import httpx
import pandas as pd

from vigil.actions import ControlApiExecutor, DryRunExecutor
from vigil.alerts import Alert
from vigil.evidence import LiveEvidence, ReplayEvidence
from vigil.investigations import investigate, product_memory, review
from vigil.memory import Memory
from vigil.queue import LEASE_SECONDS, Job, Queue
from vigil.telemetry import PROMETHEUS_URL

POLL_SECONDS = 2
HEARTBEAT_SECONDS = LEASE_SECONDS / 3  # three missed beats before the lease runs out
Handler = Callable[[dict], dict]


def enqueue_investigation(
    queue: Queue,
    investigation_id: str,
    alert: Alert,
    as_of: pd.Timestamp,
    mode: str,
    dataset: Path | None = None,
) -> int | None:
    """Queue an investigation; None if this investigation is already queued."""
    payload = {
        "id": investigation_id,
        "alert": alert.to_dict(),
        "as_of": as_of.isoformat(),
        "mode": mode,
        "dataset": str(dataset) if dataset else None,
    }
    return queue.enqueue("investigate", payload, key=f"investigate:{investigation_id}")


def enqueue_review(queue: Queue, investigation_id: str, decision: dict) -> int | None:
    return queue.enqueue(
        "review", {"id": investigation_id, **decision}, key=f"review:{investigation_id}"
    )


def worker_name() -> str:
    return f"{socket.gethostname()}-{os.getpid()}"


def handlers(memory: Memory | None) -> dict[str, Handler]:
    def run_investigation(payload: dict) -> dict:
        alert = Alert.from_dict(payload["alert"])
        as_of = pd.Timestamp(payload["as_of"])
        if payload["mode"] == "live":
            client = httpx.Client(base_url=PROMETHEUS_URL, timeout=30)
            evidence = LiveEvidence(client, as_of=as_of)
        else:
            evidence = ReplayEvidence(Path(payload["dataset"]), as_of=as_of)
        report = investigate(payload["id"], alert, evidence, memory=memory)
        return {"diagnosis": report["diagnosis"], "proposal": report["proposal"]}

    def run_review(payload: dict) -> dict:
        live = payload["id"].startswith("live-")
        report = review(
            payload["id"],
            payload["verdict"],
            payload.get("notes", ""),
            approve=payload.get("approve", False),
            by=payload.get("by", "reviewer"),
            instead=payload.get("instead"),
            memory=memory,
            executor=ControlApiExecutor() if live else DryRunExecutor(),
        )
        return {"status": report["status"], "action": report["action"]}

    return {"investigate": run_investigation, "review": run_review}


class Heartbeat:
    """Renews a job's lease in the background while the job runs."""

    def __init__(self, queue: Queue, job: Job, worker: str) -> None:
        self.queue, self.job, self.worker = queue, job, worker
        self.lost = False
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._beat, daemon=True)

    def _beat(self) -> None:
        while not self._stop.wait(HEARTBEAT_SECONDS):
            if not self.queue.heartbeat(self.job, self.worker):
                self.lost = True  # another worker reclaimed it; ours finishes but cannot complete
                return

    def __enter__(self) -> "Heartbeat":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._thread.join()


def run_once(queue: Queue, beats: Queue, worker: str, jobs: dict[str, Handler]) -> Job | None:
    """Claim one job and run it; returns the job, or None if nothing was ready."""
    job = queue.claim(worker)
    if job is None:
        return None
    print(f"[{worker}] job {job.id} {job.kind} {job.payload.get('id')} (attempt {job.attempts})")
    try:
        with Heartbeat(beats, job, worker):
            result = jobs[job.kind](job.payload)
    except Exception as error:
        status = queue.fail(job, worker, f"{type(error).__name__}: {error}"[:2000])
        print(f"[{worker}] job {job.id} failed: {error} -> {status}")
        return job
    if not queue.complete(job, worker, result):
        print(f"[{worker}] job {job.id} was reclaimed by another worker; not completing it")
    else:
        print(f"[{worker}] job {job.id} done")
    return job


def main(url: str) -> None:
    worker = worker_name()
    queue, beats = Queue(url), Queue(url)  # the heartbeat thread gets its own connection
    jobs = handlers(product_memory())
    print(f"[{worker}] waiting for jobs. Press Ctrl+C to stop.", flush=True)
    try:
        while True:
            if run_once(queue, beats, worker, jobs) is None:
                time.sleep(POLL_SECONDS)
    except KeyboardInterrupt:
        print(f"[{worker}] stopped.")
    finally:
        queue.close()
        beats.close()

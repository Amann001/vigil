"""Watch the live shop: detect anomalies every few seconds and investigate each new alert.

The detector is trained on the healthy warm-up of the latest recorded campaign. Every
POLL_SECONDS the watcher fetches the last few minutes of metrics from Prometheus; when an alarm
fires, the agents investigate the live shop at that moment and the diagnosis waits for review.
"""

import time
from collections.abc import Callable

import httpx
import pandas as pd

from vigil.alerts import Alert, AlertDetector
from vigil.evidence import LiveEvidence
from vigil.investigations import default_store, format_report, investigate, product_memory
from vigil.memory import Memory
from vigil.queue import Queue
from vigil.shop_benchmark import latest_dataset, load
from vigil.telemetry import PROMETHEUS_URL, STEP_SECONDS, fetch_features
from vigil.worker import enqueue_investigation

POLL_SECONDS = STEP_SECONDS
LOOKBACK = pd.Timedelta("3min")  # enough for the 30 s rate windows and 3 alarm points in a row
# A service stays abnormal until it is fixed, which waits for a human review, so it is paged for
# at most once in this long. Another service's alarm is a new incident and is paged at once.
# (A single quiet period for all services, as before, re-paged a payments incident that was
# still awaiting review, and swallowed an inventory incident that began during it.)
SAME_SERVICE_COOLDOWN = pd.Timedelta("30min")


def trained_detector() -> AlertDetector:
    data = load(latest_dataset())
    training = (data.features.index >= data.train_start) & (data.features.index < data.train_end)
    return AlertDetector().fit(data.features[training])


def alert_service(alert: Alert) -> str:
    """The service an alert is about: its most unusual signal's (the callee, for a call)."""
    subject = alert.signals[0].feature.split(".")[0]
    return subject.split("->")[-1]


class Pager:
    """Decides which alarms page the team: each alarm once, each service at most once per
    SAME_SERVICE_COOLDOWN."""

    def __init__(self, since: pd.Timestamp) -> None:
        self.seen_until = since  # alarms that started before this have been considered
        self.last_paged: dict[str, pd.Timestamp] = {}

    def new_alert(self, detector: AlertDetector, features: pd.DataFrame) -> Alert | None:
        for alert in detector.alerts(features):
            if alert.detected_at <= self.seen_until:
                continue
            self.seen_until = alert.detected_at
            service = alert_service(alert)
            last = self.last_paged.get(service)
            if last is not None and alert.detected_at - last < SAME_SERVICE_COOLDOWN:
                continue  # the same incident, still unresolved
            self.last_paged[service] = alert.detected_at
            return alert
        return None


def watch(
    client: httpx.Client,
    detector: AlertDetector,
    on_report: Callable[[dict], None] = lambda r: print(format_report(r)),
    max_alerts: int | None = None,
    memory: Memory | None = None,
    queue: Queue | None = None,
) -> None:
    """With a queue, each alert becomes a job for the workers and watching carries on at
    once; without one, the watcher investigates each alert itself before watching again."""
    pager = Pager(since=pd.Timestamp.now(tz="UTC"))
    handled = 0
    while max_alerts is None or handled < max_alerts:
        now = pd.Timestamp.now(tz="UTC")
        features = fetch_features((now - LOOKBACK).to_pydatetime(), now.to_pydatetime(), client)
        alert = pager.new_alert(detector, features)
        if alert is None:
            time.sleep(POLL_SECONDS)
            continue
        print(alert.describe(), flush=True)
        identifier = f"live-{alert.detected_at:%Y%m%dT%H%M%SZ}"
        as_of = pd.Timestamp.now(tz="UTC").floor("s")
        if queue is not None:
            job = enqueue_investigation(queue, identifier, alert, as_of, mode="live")
            print(f"Queued investigation {identifier} as job {job}.", flush=True)
        else:
            print("Investigating ...", flush=True)
            evidence = LiveEvidence(client, as_of=as_of)
            on_report(investigate(identifier, alert, evidence, memory=memory))
            print(f"Review it with: vigil review {identifier} --confirm --approve (or --reject)")
        handled += 1


def main(max_alerts: int | None = None) -> None:
    detector = trained_detector()
    store = default_store()
    queue = Queue(store) if isinstance(store, str) else None
    memory = None if queue is not None else product_memory()  # workers load their own
    target = "the job queue" if queue is not None else "this process"
    print(
        f"Watching {PROMETHEUS_URL} every {POLL_SECONDS} s; alerts go to {target}. "
        "Press Ctrl+C to stop.",
        flush=True,
    )
    with httpx.Client(base_url=PROMETHEUS_URL, timeout=30) as client:
        try:
            watch(client, detector, max_alerts=max_alerts, memory=memory, queue=queue)
        except KeyboardInterrupt:
            print("Stopped watching.")

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
from vigil.investigations import format_report, investigate, product_memory
from vigil.memory import Memory
from vigil.shop_benchmark import latest_dataset, load
from vigil.telemetry import PROMETHEUS_URL, STEP_SECONDS, fetch_features

POLL_SECONDS = STEP_SECONDS
LOOKBACK = pd.Timedelta("3min")  # enough for the 30 s rate windows and 3 alarm points in a row
# After an investigation, ignore alarms for a while: the same incident keeps metrics abnormal
# and should not page twice.
COOLDOWN = pd.Timedelta("5min")


def trained_detector() -> AlertDetector:
    data = load(latest_dataset())
    training = (data.features.index >= data.train_start) & (data.features.index < data.train_end)
    return AlertDetector().fit(data.features[training])


def new_alert(
    detector: AlertDetector, features: pd.DataFrame, quiet_until: pd.Timestamp
) -> Alert | None:
    """The first alert in the window that fired after `quiet_until`, if any."""
    for alert in detector.alerts(features):
        if alert.detected_at > quiet_until:
            return alert
    return None


def watch(
    client: httpx.Client,
    detector: AlertDetector,
    on_report: Callable[[dict], None] = lambda r: print(format_report(r)),
    max_alerts: int | None = None,
    memory: Memory | None = None,
) -> None:
    quiet_until = pd.Timestamp.now(tz="UTC")
    handled = 0
    while max_alerts is None or handled < max_alerts:
        now = pd.Timestamp.now(tz="UTC")
        features = fetch_features((now - LOOKBACK).to_pydatetime(), now.to_pydatetime(), client)
        alert = new_alert(detector, features, quiet_until)
        if alert is None:
            time.sleep(POLL_SECONDS)
            continue
        print(alert.describe(), flush=True)
        print("Investigating ...", flush=True)
        identifier = f"live-{alert.detected_at:%Y%m%dT%H%M%SZ}"
        evidence = LiveEvidence(client, as_of=pd.Timestamp.now(tz="UTC").floor("s"))
        on_report(investigate(identifier, alert, evidence, memory=memory))
        print(f"Review it with: vigil review {identifier} --confirm --approve (or --reject)")
        handled += 1
        quiet_until = pd.Timestamp.now(tz="UTC") + COOLDOWN


def main(max_alerts: int | None = None) -> None:
    detector = trained_detector()
    memory = product_memory()
    print(f"Watching {PROMETHEUS_URL} every {POLL_SECONDS} s. Press Ctrl+C to stop.", flush=True)
    with httpx.Client(base_url=PROMETHEUS_URL, timeout=30) as client:
        try:
            watch(client, detector, max_alerts=max_alerts, memory=memory)
        except KeyboardInterrupt:
            print("Stopped watching.")

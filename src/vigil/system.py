"""What the war-room UI shows of the live shop: each service's health, the calls between them,
and how unusual the detector finds the last few minutes.

It is read from the same Prometheus features the detector and the agents use, so the UI shows
exactly what Vigil sees. Snapshots are cached for a few seconds: several open browser tabs then
cost Prometheus no more than one.
"""

import math
import threading
import time
from collections.abc import Callable

import httpx
import pandas as pd

from vigil.alerts import AlertDetector
from vigil.telemetry import DEPENDENCIES as EDGES
from vigil.telemetry import PROMETHEUS_URL, SERVICES, fetch_features

SERVICE_METRICS = ("up", "request_rate", "error_ratio", "latency_p95", "memory_mb", "cpu")
EDGE_METRICS = ("failure_ratio", "latency_p95")
WINDOW = pd.Timedelta("10min")
CACHE_SECONDS = 4.0


def _number(value) -> float | None:
    """JSON has no NaN: a series that stopped reporting becomes None."""
    value = float(value)
    return None if math.isnan(value) or math.isinf(value) else round(value, 5)


def _series(column: pd.Series) -> list[float | None]:
    return [_number(v) for v in column]


def summarise(features: pd.DataFrame, detector: AlertDetector | None) -> dict:
    """A JSON-ready view of a window of features: latest values and the series behind them."""
    if features.empty:
        return {"online": False}
    latest = features.ffill().iloc[-1]

    def latest_of(name: str) -> float | None:
        return _number(latest[name]) if name in latest else None

    services = {
        s: {
            "latest": {m: latest_of(f"{s}.{m}") for m in SERVICE_METRICS},
            "series": {
                m: _series(features[f"{s}.{m}"]) for m in SERVICE_METRICS if f"{s}.{m}" in features
            },
        }
        for s in SERVICES
    }
    # A service that stopped reporting has no fresh "up" sample: the last row is NaN.
    for s in SERVICES:
        last = features[f"{s}.up"].iloc[-1] if f"{s}.up" in features else math.nan
        services[s]["latest"]["up"] = None if math.isnan(last) else _number(last)
    edges = [
        {
            "from": caller,
            "to": callee,
            "latest": {m: latest_of(f"{caller}->{callee}.{m}") for m in EDGE_METRICS},
        }
        for caller, callee in EDGES
    ]
    view = {
        "online": True,
        "times": [t.isoformat() for t in features.index],
        "services": services,
        "edges": edges,
    }
    if detector is not None:
        scores = detector.detector.score(features)
        view["score"] = {"values": _series(scores), "threshold": _number(detector.threshold)}
    return view


class SystemView:
    """Snapshots of the live shop, at most one Prometheus fetch per CACHE_SECONDS."""

    def __init__(
        self,
        detector_factory: Callable[[], AlertDetector | None],
        fetch: Callable[[pd.Timestamp, pd.Timestamp], pd.DataFrame] | None = None,
    ) -> None:
        self._detector_factory = detector_factory
        self._detector: AlertDetector | None = None
        self._fetch = fetch or self._from_prometheus
        self._lock = threading.Lock()
        self._cached: tuple[float, dict] | None = None

    @staticmethod
    def _from_prometheus(start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
        with httpx.Client(base_url=PROMETHEUS_URL, timeout=5) as client:
            return fetch_features(start.to_pydatetime(), end.to_pydatetime(), client)

    def snapshot(self) -> dict:
        with self._lock:
            if self._cached and time.monotonic() - self._cached[0] < CACHE_SECONDS:
                return self._cached[1]
            now = pd.Timestamp.now(tz="UTC")
            try:
                features = self._fetch(now - WINDOW, now)
            except httpx.HTTPError:
                view = {"online": False}
            else:
                if self._detector is None:
                    self._detector = self._detector_factory()
                view = summarise(features, self._detector)
            self._cached = (time.monotonic(), view)
            return view

import math

import httpx
import numpy as np
import pandas as pd

from vigil.alerts import AlertDetector
from vigil.system import CACHE_SECONDS, SystemView, summarise
from vigil.telemetry import DEPENDENCIES, SERVICES, feature_queries


def healthy(rows: int = 60, seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    index = pd.date_range("2026-11-11T10:00Z", periods=rows, freq="5s")
    columns = list(feature_queries())
    frame = pd.DataFrame(1 + 0.01 * rng.standard_normal((rows, len(columns))), index, columns)
    for s in SERVICES:
        frame[f"{s}.up"] = 1.0
    return frame


def test_the_view_has_every_service_and_dependency_with_its_latest_values():
    features = healthy()

    view = summarise(features, detector=None)

    assert view["online"] and set(view["services"]) == set(SERVICES)
    assert len(view["edges"]) == len(DEPENDENCIES)
    payments = view["services"]["payments"]
    assert payments["latest"]["up"] == 1.0
    assert len(payments["series"]["latency_p95"]) == len(features)


def test_a_service_that_stopped_reporting_is_shown_as_down_not_as_its_last_value():
    features = healthy()
    features.loc[features.index[-3:], "payments.up"] = math.nan

    view = summarise(features, detector=None)

    assert view["services"]["payments"]["latest"]["up"] is None
    assert view["services"]["payments"]["series"]["up"][-1] is None  # JSON has no NaN


def test_the_view_includes_the_detectors_scores_and_threshold():
    detector = AlertDetector().fit(healthy(seed=1))

    view = summarise(healthy(seed=2), detector)

    assert len(view["score"]["values"]) == len(view["times"])
    assert view["score"]["threshold"] == round(detector.threshold, 5)


def test_snapshots_are_cached_and_an_unreachable_prometheus_means_offline():
    calls = []

    def fetch(start, end):
        calls.append(start)
        raise httpx.ConnectError("refused")

    view = SystemView(lambda: None, fetch=fetch)

    first, second = view.snapshot(), view.snapshot()

    assert first == second == {"online": False}
    assert len(calls) == 1, f"a second fetch within {CACHE_SECONDS} s should be cached"

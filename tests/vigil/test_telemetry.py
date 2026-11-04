from datetime import UTC, datetime

import httpx
import pandas as pd
import pytest

from vigil.telemetry import SERVICES, feature_queries, fetch_features, query_range

START = datetime(2026, 11, 4, 12, 0, 3, 718000, tzinfo=UTC)  # deliberately not on a 5 s mark
END = datetime(2026, 11, 4, 12, 1, 0, tzinfo=UTC)


class FakePrometheus:
    """Answers query_range like Prometheus: one point every `step` seconds from `start`."""

    def __init__(self, empty_queries: tuple[str, ...] = ()) -> None:
        self.queries: list[str] = []
        self.empty_queries = empty_queries

    def handle(self, request: httpx.Request) -> httpx.Response:
        params = request.url.params
        query = params["query"]
        self.queries.append(query)
        if any(text in query for text in self.empty_queries):
            return httpx.Response(200, json={"status": "success", "data": {"result": []}})
        start, end, step = float(params["start"]), float(params["end"]), float(params["step"])
        points = []
        t = start
        while t <= end:
            points.append([t, "1.5"])
            t += step
        result = [{"metric": {}, "values": points}]
        return httpx.Response(200, json={"status": "success", "data": {"result": result}})


def client_for(fake: FakePrometheus) -> httpx.Client:
    return httpx.Client(base_url="http://prom", transport=httpx.MockTransport(fake.handle))


def test_every_service_has_the_same_features():
    names = feature_queries()

    for service in SERVICES:
        per_service = {n.split(".", 1)[1] for n in names if n.startswith(f"{service}.")}
        assert per_service == {
            "up",
            "request_rate",
            "error_ratio",
            "latency_p50",
            "latency_p95",
            "in_flight",
            "memory_mb",
            "cpu",
        }


def test_queries_select_only_their_own_service():
    for name, query in feature_queries().items():
        service = name.split(".")[0].split("->")[0]
        if service in SERVICES:
            assert f'service="{service}"' in query, name


def test_unaligned_start_still_fills_every_row():
    frame = fetch_features(START, END, client_for(FakePrometheus()))

    assert frame.index[0] == pd.Timestamp("2026-11-04 12:00:00", tz="UTC")
    assert frame.index.freq == "5s"
    assert len(frame) == 13  # 12:00:00 .. 12:01:00
    assert frame.notna().all().all()
    assert list(frame.columns) == list(feature_queries())


def test_missing_series_become_nan_not_errors():
    fake = FakePrometheus(empty_queries=('service="payments"',))

    frame = fetch_features(START, END, client_for(fake))

    assert frame["payments.up"].isna().all()
    assert frame["orders.up"].notna().all()


def test_query_failure_is_raised():
    def broken(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "error", "error": "parse error"})

    client = httpx.Client(base_url="http://prom", transport=httpx.MockTransport(broken))

    with pytest.raises(RuntimeError, match="parse error"):
        query_range("up", START, END, client)


def test_more_than_one_series_is_rejected():
    def two_series(request: httpx.Request) -> httpx.Response:
        series = {"metric": {}, "values": [[1, "1"]]}
        return httpx.Response(200, json={"status": "success", "data": {"result": [series, series]}})

    client = httpx.Client(base_url="http://prom", transport=httpx.MockTransport(two_series))

    with pytest.raises(ValueError, match="one series"):
        query_range("up", START, END, client)

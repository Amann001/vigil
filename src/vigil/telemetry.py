"""Read the shop's metrics from Prometheus as a feature table.

Each feature is one PromQL query producing one time series. Fetched together they form a table
with one row per scrape interval and one column per signal: the input to anomaly detection.
"""

from datetime import datetime

import httpx
import pandas as pd

PROMETHEUS_URL = "http://127.0.0.1:9090"
SERVICES = ["storefront", "orders", "payments", "inventory"]
# Who calls whom in the shop.
DEPENDENCIES = [
    ("storefront", "inventory"),
    ("storefront", "orders"),
    ("orders", "inventory"),
    ("orders", "payments"),
]
# Rates are averaged over this window: long enough to smooth noise at a few requests per
# second, short enough that an incident shows within a few scrapes.
WINDOW = "30s"
STEP_SECONDS = 5  # Prometheus scrape interval

_QUANTILE = "histogram_quantile({q}, sum by (le) (rate({metric}_bucket{{{selector}}}[{w}])))"


def _service_features(s: str) -> dict[str, str]:
    sel = f'service="{s}"'
    requests = f"sum(rate(http_requests_total{{{sel}}}[{WINDOW}]))"
    errors = f'sum(rate(http_requests_total{{{sel},status=~"5.."}}[{WINDOW}]))'
    return {
        f"{s}.up": f"max(up{{{sel}}})",
        f"{s}.request_rate": requests,
        f"{s}.error_ratio": f"({errors} or vector(0)) / clamp_min({requests}, 1e-9)",
        f"{s}.latency_p50": _QUANTILE.format(
            q=0.5, metric="http_request_duration_seconds", selector=sel, w=WINDOW
        ),
        f"{s}.latency_p95": _QUANTILE.format(
            q=0.95, metric="http_request_duration_seconds", selector=sel, w=WINDOW
        ),
        f"{s}.in_flight": f"sum(http_requests_in_progress{{{sel}}})",
        f"{s}.memory_mb": f"max(process_resident_memory_bytes{{{sel}}}) / 1e6",
        f"{s}.cpu": f"sum(rate(process_cpu_seconds_total{{{sel}}}[{WINDOW}]))",
    }


def _dependency_features(caller: str, callee: str) -> dict[str, str]:
    sel = f'service="{caller}",dependency="{callee}"'
    calls = f"sum(rate(dependency_calls_total{{{sel}}}[{WINDOW}]))"
    failed = f'sum(rate(dependency_calls_total{{{sel},outcome!="ok"}}[{WINDOW}]))'
    return {
        f"{caller}->{callee}.failure_ratio": f"({failed} or vector(0)) / clamp_min({calls}, 1e-9)",
        f"{caller}->{callee}.latency_p95": _QUANTILE.format(
            q=0.95, metric="dependency_call_duration_seconds", selector=sel, w=WINDOW
        ),
    }


def feature_queries() -> dict[str, str]:
    """Every feature name mapped to the PromQL that computes it."""
    queries: dict[str, str] = {}
    for service in SERVICES:
        queries |= _service_features(service)
    for caller, callee in DEPENDENCIES:
        queries |= _dependency_features(caller, callee)
    customer_requests = f"sum(rate(traffic_requests_total[{WINDOW}]))"
    customer_errors = (
        f'sum(rate(traffic_requests_total{{outcome=~"server_error|timeout|unreachable"}}'
        f"[{WINDOW}]))"
    )
    queries["customers.error_ratio"] = (
        f"({customer_errors} or vector(0)) / clamp_min({customer_requests}, 1e-9)"
    )
    queries["customers.session_rate"] = f"sum(rate(traffic_sessions_total[{WINDOW}]))"
    return queries


def query_range(
    query: str,
    start: datetime,
    end: datetime,
    client: httpx.Client,
    step: int = STEP_SECONDS,
) -> pd.Series:
    """One PromQL query over a time range, as a series indexed by UTC timestamp."""
    response = client.get(
        "/api/v1/query_range",
        params={"query": query, "start": start.timestamp(), "end": end.timestamp(), "step": step},
    )
    payload = response.raise_for_status().json()
    if payload["status"] != "success":
        raise RuntimeError(f"Prometheus query failed: {payload}")
    results = payload["data"]["result"]
    if not results:
        return pd.Series(dtype=float)
    if len(results) > 1:
        raise ValueError(f"Expected one series, got {len(results)} for: {query}")
    timestamps, values = zip(*results[0]["values"], strict=True)
    # Round to whole milliseconds: float seconds like 1793803313.313 otherwise come back as
    # ...312999964 ns and never compare equal to the table's timestamps.
    index = pd.to_datetime(list(timestamps), unit="s", utc=True).round("ms")
    return pd.Series([float(v) for v in values], index=index)


def fetch_features(
    start: datetime,
    end: datetime,
    client: httpx.Client,
    step: int = STEP_SECONDS,
) -> pd.DataFrame:
    """All features over a time range: one row per step, one column per feature.

    Missing values are kept as NaN on purpose: a service that is down stops reporting, and that
    absence is itself a signal.
    """
    # Prometheus returns points at start + k * step. Starting on an exact step boundary puts
    # every point on a row of the table; an unaligned start would match no row at all.
    first = pd.Timestamp(start).floor(f"{step}s")
    last = pd.Timestamp(end).floor(f"{step}s")
    index = pd.date_range(first, last, freq=f"{step}s")
    columns = {
        name: query_range(query, first.to_pydatetime(), last.to_pydatetime(), client, step).reindex(
            index
        )
        for name, query in feature_queries().items()
    }
    frame = pd.DataFrame(columns, index=index)
    frame.index.name = "timestamp"
    return frame

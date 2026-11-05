import gzip
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from vigil import tools
from vigil.alerts import TOP_SIGNALS, AlertDetector
from vigil.evidence import ReplayEvidence, parse_log_lines
from vigil.telemetry import feature_queries

START = pd.Timestamp("2026-11-04T12:00:00Z")
CRASH = START + pd.Timedelta("50min")  # payments stops reporting
ALERT = CRASH + pd.Timedelta("30s")
END = START + pd.Timedelta("60min")
FEATURES = list(feature_queries())


def log_line(time: pd.Timestamp, service: str, level: str, message: str, **fields) -> str:
    entry = {
        "timestamp": time.isoformat(timespec="milliseconds"),
        "level": level,
        "service": service,
        "logger": f"shop.{service}",
        "message": message,
        **fields,
    }
    return json.dumps(entry)


def write_dataset(directory: Path) -> Path:
    """An hour of a healthy shop in which payments crashes at minute 50."""
    index = pd.date_range(START, END, freq="5s", name="timestamp")
    rng = np.random.default_rng(0)
    metrics = pd.DataFrame(1.0 + rng.normal(0, 0.01, (len(index), len(FEATURES))), index, FEATURES)
    metrics[[f for f in FEATURES if f.endswith(".up")]] = 1.0
    metrics[[f for f in FEATURES if "error" in f or "failure" in f]] = 0.0
    down = index >= CRASH
    metrics.loc[down, [f for f in FEATURES if f.startswith("payments.")]] = np.nan
    metrics.loc[down, "payments.up"] = 0.0
    metrics.loc[down, "orders->payments.failure_ratio"] = 1.0
    metrics["anomaly"] = down  # a label column: must never reach the agents
    metrics.to_csv(directory / "metrics.csv.gz")
    (directory / "meta.json").write_text(json.dumps({"features": FEATURES}))

    raw = directory / "raw_logs"
    raw.mkdir()
    healthy = [
        log_line(START + pd.Timedelta(seconds=s), "orders", "WARNING", "order failed")
        for s in range(0, 3600, 60)
    ]
    crash = [
        log_line(
            CRASH + pd.Timedelta(seconds=s),
            "orders",
            "ERROR",
            "dependency unreachable",
            dependency="payments",
        )
        for s in range(0, 60, 5)
    ]
    with gzip.open(raw / "orders.jsonl.gz", "wt", encoding="utf-8") as file:
        file.write("\n".join(sorted(healthy + crash)) + "\n")
    return directory


@pytest.fixture
def evidence(tmp_path) -> ReplayEvidence:
    return ReplayEvidence(write_dataset(tmp_path), as_of=ALERT)


def test_replay_never_shows_the_future_or_the_labels(evidence):
    metrics, logs = evidence.metrics(60), evidence.logs(60)

    assert metrics.index.max() <= ALERT
    assert logs["timestamp"].max() <= ALERT
    assert "anomaly" not in metrics.columns


def test_log_lines_outside_the_window_are_skipped_and_fields_kept():
    lines = [
        log_line(START, "orders", "INFO", "too early"),
        log_line(START + pd.Timedelta("1min"), "orders", "ERROR", "boom", status=503),
        '{"level": "INFO", "timestamp": "2026-11-04T12:01:30.000+00:00", "service": "orders", '
        '"logger": "x", "message": "timestamp not first"}',
    ]

    table = parse_log_lines(lines, START + pd.Timedelta("30s"), START + pd.Timedelta("2min"))

    assert list(table["message"]) == ["boom", "timestamp not first"]
    assert table["fields"].iloc[0] == {"status": 503}


def test_service_overview_shows_the_down_service_against_usual(evidence):
    report = tools.service_overview(evidence)

    payments = next(line for line in report.splitlines() if line.startswith("- payments"))
    assert "up=0 (usual 1" in payments
    assert "req/s=missing" in payments


def test_dependency_overview_shows_failing_calls(evidence):
    report = tools.dependency_overview(evidence)

    assert "orders->payments: failures=100.0% (usual 0.0%" in report


def test_availability_reports_when_a_service_went_down(evidence):
    report = tools.availability(evidence)

    assert "payments: DOWN now; down -0m30s to -0m00s" in report
    assert "orders: up now; no downtime" in report


def test_log_summary_marks_kinds_of_line_never_seen_before(evidence):
    report = tools.log_summary(evidence, service="orders")

    unreachable = next(line for line in report.splitlines() if "unreachable" in line)
    failed = next(line for line in report.splitlines() if "order failed" in line)
    assert unreachable.endswith("NEW")
    assert not failed.endswith("NEW")


def test_search_logs_filters_and_shows_fields(evidence):
    report = tools.search_logs(evidence, level="error", contains="payments", limit=2)

    assert report.startswith("7 matching lines; the last 2:")
    assert "'dependency': 'payments'" in report


def test_metric_history_ends_at_the_alert_and_rejects_unknown_names(evidence):
    report = tools.metric_history(evidence, "payments.up", minutes=2)

    assert report.splitlines()[-1] == "-0m00s: 0"
    assert "Unknown metric" in tools.metric_history(evidence, "payments.nope")


def test_windows_are_capped(evidence):
    report = tools.availability(evidence, minutes=600)

    assert report.startswith(f"Availability in the last {tools.MAX_MINUTES} min")


def test_alert_names_the_most_unusual_signals(tmp_path):
    evidence = ReplayEvidence(write_dataset(tmp_path), as_of=END)
    table = evidence.metrics(60)
    detector = AlertDetector().fit(table[table.index < CRASH])

    (alert,) = detector.alerts(table)

    assert CRASH <= alert.detected_at <= CRASH + pd.Timedelta("30s")
    assert len(alert.signals) == TOP_SIGNALS
    assert alert.signals[0].feature.startswith(("payments.", "orders->payments"))
    assert "payments.up: 0, usual 1" in alert.describe()


def test_agents_never_read_ground_truth():
    """The fault ledger and incident labels are for scoring only: the agent code must not open
    those files or import the modules that read them."""
    source = Path(__file__).parents[2] / "src" / "vigil"
    forbidden = (
        "ledger.jsonl",
        "incidents.json",
        "campaign.json",
        "shop.chaos",
        "shop import chaos",
        "vigil.incidents",
        "CHAOS_",
    )
    for module in ("evidence.py", "tools.py", "agents.py", "alerts.py", "llm.py"):
        text = (source / module).read_text(encoding="utf-8")
        for name in forbidden:
            assert name not in text, f"{module} mentions {name}"

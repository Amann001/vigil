import operator
from typing import Annotated, TypedDict

import pandas as pd
import pytest
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from vigil import investigations
from vigil.agent_eval import EXPECTED_CATEGORY, matching_incident, score
from vigil.alerts import Alert, AlertDetector, Signal
from vigil.cli import main as cli
from vigil.watch import new_alert

ALERT = Alert(pd.Timestamp("2026-11-04T16:32:25Z"), (Signal("payments.up", 0.0, 1.0, 1000.0),))
DIAGNOSIS = {
    "root_cause_service": "payments",
    "category": "service_crash",
    "summary": "payments crashed",
    "evidence": ["payments.up = 0"],
    "affected_services": ["orders"],
    "confidence": "high",
    "next_steps": ["restart payments"],
}


class State(TypedDict, total=False):
    alert: str
    findings: Annotated[list, operator.add]
    models: Annotated[list, operator.add]
    diagnosis: dict
    review: dict


def stand_in_graph(checkpointer=None):
    """The real graph's shape without models: diagnose, then pause for review."""
    graph = StateGraph(State)
    graph.add_node("diagnose", lambda s: {"diagnosis": DIAGNOSIS, "models": ["diagnosis: fake"]})
    graph.add_node("review", lambda s: {"review": interrupt({"diagnosis": s["diagnosis"]})})
    graph.add_edge(START, "diagnose")
    graph.add_edge("diagnose", "review")
    graph.add_edge("review", END)
    return graph.compile(checkpointer=checkpointer)


@pytest.fixture
def store(monkeypatch, tmp_path):
    monkeypatch.setattr(investigations, "build_graph", stand_in_graph)
    monkeypatch.setattr(investigations, "DB_PATH", tmp_path / "vigil.db")
    monkeypatch.setattr(investigations, "REPORTS_DIR", tmp_path / "reports")
    return tmp_path


def run(store, identifier="replay-x-03"):
    return investigations.investigate(
        identifier, ALERT, evidence=None, db_path=store / "vigil.db", reports_dir=store / "reports"
    )


def test_investigation_is_saved_awaiting_review(store):
    report = run(store)

    assert report["status"] == "awaiting review"
    assert report["diagnosis"] == DIAGNOSIS
    assert investigations.load_reports(store / "reports") == [report]


def test_review_resumes_the_paused_investigation(store):
    run(store)

    report = investigations.review(
        "replay-x-03", "corrected", "it was a leak", store / "vigil.db", store / "reports"
    )

    assert report["status"] == "corrected"
    assert report["review"]["notes"] == "it was a leak"
    with pytest.raises(ValueError, match="not awaiting review"):
        investigations.review("replay-x-03", "confirmed", "", store / "vigil.db", store / "reports")


def test_review_of_an_unknown_investigation_fails(store):
    with pytest.raises(KeyError):
        investigations.review("nope", "confirmed", "", store / "vigil.db", store / "reports")


def test_cli_lists_shows_and_reviews(store, capsys, monkeypatch):
    import vigil.cli

    run(store)
    monkeypatch.setattr(
        vigil.cli, "load_reports", lambda: investigations.load_reports(store / "reports")
    )
    monkeypatch.setattr(
        vigil.cli,
        "review",
        lambda i, v, n="": investigations.review(i, v, n, store / "vigil.db", store / "reports"),
    )

    cli(["list"])
    cli(["review", "replay-x-03", "--confirm"])

    output = capsys.readouterr().out
    assert "replay-x-03" in output and "payments service_crash (high)" in output
    assert "[confirmed]" in output


INCIDENTS = [
    {
        "id": 3,
        "service": "payments",
        "fault": "crash",
        "start": "2026-11-04T16:32:10+00:00",
        "end": "2026-11-04T16:36:39+00:00",
    },
]


def test_alerts_are_matched_to_the_incident_they_fall_in():
    assert matching_incident(pd.Timestamp("2026-11-04T16:32:25Z"), INCIDENTS)["id"] == 3
    assert matching_incident(pd.Timestamp("2026-11-04T16:20:00Z"), INCIDENTS) is None


def test_score_checks_service_and_kind_of_failure():
    right = {
        "id": "a",
        "alert_at": "2026-11-04T16:32:25+00:00",
        "seconds": 80,
        "models": ["diagnosis: gemini/x"],
        "diagnosis": DIAGNOSIS,
    }
    wrong_kind = right | {"id": "b", "diagnosis": DIAGNOSIS | {"category": "memory_leak"}}

    result = score([right, wrong_kind], INCIDENTS)

    assert result["service_accuracy"] == 1.0
    assert result["category_accuracy"] == 0.5
    assert result["fully_correct"] == 1
    assert result["diagnosis_models"] == {"gemini/x": 2}
    assert set(EXPECTED_CATEGORY) == {"crash", "leak", "latency", "errors"}


def test_watcher_only_raises_alerts_after_the_quiet_period():
    index = pd.date_range("2026-11-04T12:00:00Z", periods=200, freq="5s")
    features = pd.DataFrame({"latency": 0.1, "rate": 5.0}, index=index)
    features.iloc[::7, 0] = 0.11
    detector = AlertDetector().fit(features)
    features.iloc[150:, 0] = 2.0  # the incident

    alert = new_alert(detector, features, quiet_until=index[0])

    assert alert is not None and alert.detected_at >= index[150]
    assert new_alert(detector, features, quiet_until=index[-1]) is None

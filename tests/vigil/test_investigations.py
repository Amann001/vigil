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
from vigil.watch import Pager, alert_service

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


def stand_in_graph(checkpointer=None, mode="multi"):
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


def paths(store) -> dict:
    return {"store": store / "vigil.db", "reports_dir": store / "reports"}


def run(store, identifier="replay-x-03"):
    return investigations.investigate(
        identifier, ALERT, evidence=None, store=store / "vigil.db", reports_dir=store / "reports"
    )


def test_investigation_is_saved_awaiting_review(store):
    report = run(store)

    assert report["status"] == "awaiting review"
    assert report["diagnosis"] == DIAGNOSIS
    assert investigations.load_reports(store / "reports") == [report]


def test_review_resumes_the_paused_investigation(store):
    run(store)

    report = investigations.review("replay-x-03", "corrected", "it was a leak", **paths(store))

    assert report["status"] == "corrected"
    assert report["review"]["notes"] == "it was a leak"
    with pytest.raises(ValueError, match="not awaiting review"):
        investigations.review("replay-x-03", "confirmed", **paths(store))


class Flaky:
    """A two-step graph whose second step fails the first time, like a process stopped mid-run."""

    def __init__(self):
        self.gathered = 0
        self.failures_left = 1

    def gather(self, state):
        self.gathered += 1
        return {"findings": ["payments down"]}

    def diagnose(self, state):
        if self.failures_left:
            self.failures_left -= 1
            raise RuntimeError("laptop lid closed")
        return {"diagnosis": DIAGNOSIS, "models": ["diagnosis: fake"]}

    def build(self, checkpointer=None, mode="multi"):
        graph = StateGraph(State)
        graph.add_node("gather", self.gather)
        graph.add_node("diagnose", self.diagnose)
        graph.add_node("review", lambda s: {"review": interrupt({"diagnosis": s["diagnosis"]})})
        graph.add_edge(START, "gather")
        graph.add_edge("gather", "diagnose")
        graph.add_edge("diagnose", "review")
        graph.add_edge("review", END)
        return graph.compile(checkpointer=checkpointer)


def test_an_interrupted_investigation_continues_where_it_stopped(store, monkeypatch):
    """Regression: restarting an interrupted investigation skipped its unfinished steps."""
    flaky = Flaky()
    monkeypatch.setattr(investigations, "build_graph", flaky.build)
    with pytest.raises(RuntimeError, match="lid closed"):
        run(store)

    report = run(store)

    assert report["resumed_from_checkpoint"] is True
    assert flaky.gathered == 1  # finished work is not redone
    assert report["findings"] == ["payments down"]
    assert report["diagnosis"] == DIAGNOSIS


def test_investigating_again_starts_from_scratch(store, monkeypatch):
    """Regression: a rerun added new findings on top of the previous run's."""
    flaky = Flaky()
    flaky.failures_left = 0
    monkeypatch.setattr(investigations, "build_graph", flaky.build)
    run(store)

    report = run(store)

    assert report["resumed_from_checkpoint"] is False
    assert report["findings"] == ["payments down"]
    assert flaky.gathered == 2


def test_checkpoints_go_to_postgres_when_configured_and_sqlite_otherwise(
    monkeypatch, tmp_path, real_default_store
):
    monkeypatch.setattr(investigations, "PROJECT_ROOT", tmp_path)  # no .env here
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert real_default_store() == investigations.DB_PATH

    monkeypatch.setenv("DATABASE_URL", "postgresql://user@example.neon.tech/vigil")
    assert real_default_store() == "postgresql://user@example.neon.tech/vigil"
    assert investigations._is_postgres(real_default_store())
    assert not investigations._is_postgres(investigations.DB_PATH)


def test_review_of_an_unknown_investigation_fails(store):
    with pytest.raises(KeyError):
        investigations.review("nope", "confirmed", **paths(store))


def test_cli_lists_shows_and_reviews(store, capsys, monkeypatch):
    import vigil.cli

    run(store)
    monkeypatch.setattr(
        vigil.cli, "load_reports", lambda: investigations.load_reports(store / "reports")
    )
    monkeypatch.setattr(
        vigil.cli,
        "review",
        lambda i, v, n="", **kw: investigations.review(i, v, n, **paths(store)),
    )

    cli(["list"])
    monkeypatch.setattr(investigations, "product_memory", lambda: None)
    cli(["review", "replay-x-03", "--confirm", "--reject"])

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


RESTART_PAYMENTS = {"action": "restart_service", "service": "payments", "cited_incidents": []}


def test_simulated_reviewer_approves_only_a_fix_of_the_real_cause():
    from vigil.agent_eval import simulated_review

    report = {"diagnosis": DIAGNOSIS, "proposal": RESTART_PAYMENTS}
    wrong = {
        "diagnosis": DIAGNOSIS | {"root_cause_service": "orders"},
        "proposal": RESTART_PAYMENTS | {"service": "orders"},
    }

    assert simulated_review(report, INCIDENTS[0]) == {
        "verdict": "confirmed",
        "notes": "",
        "approve": True,
    }
    decision = simulated_review(wrong, INCIDENTS[0])
    assert decision["verdict"] == "corrected" and not decision["approve"]
    assert "payments (service_crash)" in decision["notes"]


def test_citations_are_scored_against_earlier_incidents_of_the_same_kind():
    second = dict(
        INCIDENTS[0], id=4, start="2026-11-04T17:00:00+00:00", end="2026-11-04T17:05:00+00:00"
    )
    first_report = {
        "id": "a",
        "alert_at": "2026-11-04T16:32:25+00:00",
        "seconds": 1,
        "models": [],
        "diagnosis": DIAGNOSIS,
        "proposal": RESTART_PAYMENTS,
    }
    second_report = first_report | {
        "id": "b",
        "alert_at": "2026-11-04T17:00:20+00:00",
        "proposal": RESTART_PAYMENTS | {"cited_incidents": ["a"]},
    }

    result = score([first_report, second_report], [INCIDENTS[0], second])

    assert result["proposal_accuracy"] == 1.0
    assert (result["cited_when_possible"], result["could_cite"]) == (1, 1)
    assert result["citations_alike"] == result["citations"] == 1


def _watched(columns: list[str]):
    index = pd.date_range("2026-11-04T12:00:00Z", periods=200, freq="5s")
    features = pd.DataFrame({c: 0.1 for c in columns}, index=index)
    features.iloc[::7, 0] = 0.11
    features.iloc[::5, 1] = 0.11
    return index, features, AlertDetector().fit(features)


def test_the_pager_raises_each_alarm_once_and_ignores_older_ones():
    index, features, detector = _watched(["payments.latency_p95", "inventory.error_ratio"])
    features.iloc[150:, 0] = 2.0  # the incident

    alert = Pager(since=index[0]).new_alert(detector, features)
    pager = Pager(since=index[0])
    first, again = pager.new_alert(detector, features), pager.new_alert(detector, features)

    assert alert is not None and alert.detected_at >= index[150]
    assert first is not None and again is None
    assert Pager(since=index[-1]).new_alert(detector, features) is None


def test_the_pager_does_not_page_twice_for_one_service_but_does_for_another():
    index, features, detector = _watched(["payments.latency_p95", "inventory.error_ratio"])
    pager = Pager(since=index[0])
    features.iloc[100:120, 0] = 2.0  # payments slow ...
    features.iloc[130:150, 0] = 2.0  # ... briefly better, then slow again: the same incident
    features.iloc[160:, 1] = 0.9  # after a restart, inventory starts failing: a new one

    paged = [pager.new_alert(detector, features) for _ in range(4)]

    services = [alert_service(a) for a in paged if a is not None]
    assert services == ["payments", "inventory"]


def test_an_alarm_about_a_service_caught_up_in_a_paged_incident_is_not_paged_again():
    columns = ["inventory.error_ratio", "orders->inventory.failure_ratio", "orders.error_ratio"]
    index = pd.date_range("2026-11-04T12:00:00Z", periods=200, freq="5s")
    features = pd.DataFrame({c: 0.0 for c in columns}, index=index)
    features.iloc[::7, :] = 0.01
    detector = AlertDetector().fit(features)
    pager = Pager(since=index[0])
    features.iloc[150:160, :] = 0.5  # inventory fails, and with it orders and its calls to it
    features.iloc[150:160, 0] = 0.6  # inventory most of all
    features.iloc[162:, 2] = 0.9  # then orders' own error rate leads a second alarm

    paged = [pager.new_alert(detector, features) for _ in range(3)]

    assert [alert_service(a) for a in paged if a is not None] == ["inventory"]


def test_the_pager_stops_at_its_daily_limit():
    index, features, detector = _watched(["payments.latency_p95", "inventory.error_ratio"])
    features.iloc[100:120, 0] = 2.0  # payments: one incident
    features.iloc[160:, 1] = 0.9  # inventory: another, which would normally be paged
    pager = Pager(since=index[0], daily_limit=1)

    paged = [pager.new_alert(detector, features) for _ in range(4)]

    assert [alert_service(a) for a in paged if a is not None] == ["payments"]
    assert pager.skipped == 1

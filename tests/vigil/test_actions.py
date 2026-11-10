import httpx
import pandas as pd
import pytest

from vigil.actions import (
    RESTART_COOLDOWN,
    AuditLog,
    ControlApiExecutor,
    DryRunExecutor,
    Proposal,
    carry_out,
    problems,
)

NOW = pd.Timestamp("2026-11-08T12:00:00Z")
APPROVED = {"approved": True, "by": "aman"}


def restart(service="payments") -> Proposal:
    return Proposal(
        action="restart_service",
        service=service,
        rationale="payments leaks memory",
        runbook="memory-leak",
        expected_outcome="memory back to normal",
    )


class RecordingExecutor:
    dry_run = False

    def __init__(self):
        self.calls = []

    def execute(self, proposal):
        self.calls.append(proposal.service)
        return {"service": proposal.service, "ready": True}


@pytest.fixture
def audit(tmp_path) -> AuditLog:
    return AuditLog(tmp_path / "audit.jsonl")


def test_nothing_runs_without_approval(audit):
    executor = RecordingExecutor()

    entry = carry_out(
        restart(), {"approved": False, "notes": "wrong service"}, executor, audit, "i1"
    )

    assert entry["outcome"] == "rejected" and entry["reasons"] == ["wrong service"]
    assert executor.calls == []
    assert audit.entries() == [entry]


def test_an_approved_restart_runs_and_is_audited(audit):
    executor = RecordingExecutor()

    entry = carry_out(restart(), APPROVED, executor, audit, "i1", now=NOW)

    assert entry["outcome"] == "executed" and executor.calls == ["payments"]
    assert entry["approved_by"] == "aman"
    assert audit.last_restart("payments") == NOW


def test_restarts_are_rate_limited_per_service(audit):
    executor = RecordingExecutor()
    carry_out(restart(), APPROVED, executor, audit, "i1", now=NOW)

    again = carry_out(restart(), APPROVED, executor, audit, "i2", now=NOW + pd.Timedelta("5min"))
    other = carry_out(restart("orders"), APPROVED, executor, audit, "i3", now=NOW)
    later = carry_out(restart(), APPROVED, executor, audit, "i4", now=NOW + RESTART_COOLDOWN)

    assert again["outcome"] == "refused" and "one per 15 minutes" in again["reasons"][0]
    assert other["outcome"] == "executed" and later["outcome"] == "executed"
    assert executor.calls == ["payments", "orders", "payments"]


def test_a_restart_needs_a_service(audit):
    proposal = restart().model_copy(update={"service": None})

    assert problems(proposal, audit, NOW) == ["restart_service needs a service"]


def test_escalating_changes_nothing(audit):
    executor = RecordingExecutor()
    proposal = Proposal(
        action="escalate", service=None, rationale="unclear", runbook=None, expected_outcome="-"
    )

    entry = carry_out(proposal, APPROVED, executor, audit, "i1")

    assert entry["outcome"] == "escalated" and executor.calls == []


def test_dry_runs_do_not_count_towards_the_rate_limit(audit):
    carry_out(restart(), APPROVED, DryRunExecutor(), audit, "replay", now=NOW)

    assert audit.last_restart("payments") is None


def test_a_failed_restart_is_recorded_not_raised(audit, monkeypatch):
    def refuse(*args, **kwargs):
        raise httpx.ConnectError("control API is down")

    monkeypatch.setattr(httpx, "post", refuse)

    entry = carry_out(restart(), APPROVED, ControlApiExecutor(), audit, "i1")

    assert entry["outcome"] == "failed" and "control API is down" in entry["reasons"][0]


def test_no_action_changes_nothing(audit):
    executor = RecordingExecutor()
    proposal = Proposal(
        action="no_action",
        service=None,
        rationale="more customers than usual; latency and errors normal",
        runbook="normal-variation",
        expected_outcome="nothing to change",
    )

    entry = carry_out(proposal, APPROVED, executor, audit, "i1")

    assert entry["outcome"] == "no action" and executor.calls == []


def test_a_rejection_is_recorded_as_the_reviewers_even_when_a_guardrail_would_also_refuse(audit):
    carry_out(restart(), APPROVED, RecordingExecutor(), audit, "i1", now=NOW)

    entry = carry_out(
        restart(),
        {"approved": False, "notes": "already fixed"},
        RecordingExecutor(),
        audit,
        "i2",
        now=NOW + pd.Timedelta("5min"),
    )

    assert entry["outcome"] == "rejected" and entry["reasons"] == ["already fixed"]

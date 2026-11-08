"""What Vigil may do to the system, and the guardrails around it.

Agents read freely but change nothing on their own. A change is only ever:
1. one of the actions in ACTIONS, with valid arguments (anything else is refused);
2. approved by a human, recorded with who approved it and when;
3. allowed by the rate limit: a service restarted recently is not restarted again, so a fix
   that does not work cannot turn into a restart loop;
4. written to an audit log, whether it ran, was rejected or was refused.

Replayed incidents use DryRunExecutor, which records what would have been done.
"""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

import httpx
import pandas as pd
from pydantic import BaseModel, Field

from shop.config import DATA_DIR
from shop.control import CONTROL_PORT

AUDIT_LOG = DATA_DIR / "actions" / "audit.jsonl"
RESTART_COOLDOWN = pd.Timedelta("15min")
RESTART_TIMEOUT_SECONDS = 60
Service = Literal["storefront", "orders", "payments", "inventory"]


@dataclass(frozen=True)
class Action:
    description: str
    needs_service: bool
    changes_system: bool


ACTIONS = {
    "restart_service": Action(
        "Stop the service's process and start a fresh one. Clears in-memory state such as "
        "leaked memory, an exhausted connection pool or a hung process. Causes a brief outage "
        "(about 2 s) of that service. Does not fix a problem in another service, or one that "
        "comes back from a bad deploy or configuration.",
        needs_service=True,
        changes_system=True,
    ),
    "escalate": Action(
        "Change nothing and hand the incident to an engineer with the diagnosis, when no "
        "available action would fix it safely or the cause is unclear.",
        needs_service=False,
        changes_system=False,
    ),
    "no_action": Action(
        "Change nothing because nothing is broken: the alert reflects normal variation, such "
        "as more customers than usual, with latency and errors at their usual levels.",
        needs_service=False,
        changes_system=False,
    ),
}


class Proposal(BaseModel):
    action: Literal["restart_service", "escalate", "no_action"]
    service: Service | None = Field(description="The service to act on, for restart_service")
    rationale: str = Field(description="Why this action should fix the diagnosed root cause")
    runbook: str | None = Field(description="The runbook this follows, if any")
    expected_outcome: str = Field(description="What should be true afterwards if it worked")


class AuditLog:
    def __init__(self, path: Path = AUDIT_LOG) -> None:
        self.path = path

    def record(self, entry: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(entry, default=str) + "\n")

    def entries(self) -> list[dict]:
        if not self.path.exists():
            return []
        lines = self.path.read_text(encoding="utf-8").splitlines()
        return [json.loads(line) for line in lines if line.strip()]

    def last_restart(self, service: str) -> pd.Timestamp | None:
        times = [
            pd.Timestamp(e["at"])
            for e in self.entries()
            if e.get("outcome") == "executed"
            and e.get("action") == "restart_service"
            and e.get("service") == service
            and not e.get("dry_run")
        ]
        return max(times, default=None)


def problems(proposal: Proposal, audit: AuditLog, now: pd.Timestamp) -> list[str]:
    """Why a proposal must not run, or an empty list if it may (once approved)."""
    action = ACTIONS.get(proposal.action)
    if action is None:
        return [f"{proposal.action!r} is not an allowed action"]
    if action.needs_service and proposal.service is None:
        return [f"{proposal.action} needs a service"]
    found = []
    if proposal.action == "restart_service":
        last = audit.last_restart(proposal.service)
        if last is not None and now - last < RESTART_COOLDOWN:
            minutes = RESTART_COOLDOWN.total_seconds() / 60
            found.append(
                f"{proposal.service} was restarted at {last:%H:%M:%S}; restarts are limited to "
                f"one per {minutes:.0f} minutes so a fix that does not work cannot loop"
            )
    return found


class Executor(Protocol):
    dry_run: bool

    def execute(self, proposal: Proposal) -> dict: ...


class ControlApiExecutor:
    """Acts on the live shop through the launcher's control API."""

    dry_run = False

    def __init__(self, base_url: str = f"http://127.0.0.1:{CONTROL_PORT}") -> None:
        self.base_url = base_url

    def execute(self, proposal: Proposal) -> dict:
        response = httpx.post(
            f"{self.base_url}/restart/{proposal.service}", timeout=RESTART_TIMEOUT_SECONDS
        )
        response.raise_for_status()
        return response.json()


class DryRunExecutor:
    """For replays of recorded incidents: there is no live system to act on."""

    dry_run = True

    def execute(self, proposal: Proposal) -> dict:
        return {"service": proposal.service, "dry_run": True}


def carry_out(
    proposal: Proposal,
    approval: dict,
    executor: Executor,
    audit: AuditLog,
    incident: str,
    now: pd.Timestamp | None = None,
) -> dict:
    """Run an approved proposal if every guardrail allows it; always record the outcome."""
    now = now or pd.Timestamp.now(tz="UTC")
    entry = {
        "at": now.isoformat(),
        "incident": incident,
        "action": proposal.action,
        "service": proposal.service,
        "approved_by": approval.get("by"),
        "dry_run": executor.dry_run,
    }
    if refused := problems(proposal, audit, now):
        entry |= {"outcome": "refused", "reasons": refused}
    elif not approval.get("approved"):
        entry |= {"outcome": "rejected", "reasons": [approval.get("notes") or "not approved"]}
    elif not ACTIONS[proposal.action].changes_system:
        entry |= {"outcome": "escalated" if proposal.action == "escalate" else "no action"}
    else:
        try:
            entry |= {"outcome": "executed", "result": executor.execute(proposal)}
        except httpx.HTTPError as error:
            entry |= {"outcome": "failed", "reasons": [f"{type(error).__name__}: {error}"]}
    audit.record(entry)
    return entry

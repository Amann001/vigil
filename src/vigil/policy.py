"""Vigil's operating policy as data: what it may do, who must approve it, and what runs it.

Everything here is read from the constants the system actually enforces, so the policy page in
the UI cannot drift from the code: change a guardrail and the page changes with it.
"""

from vigil.actions import ACTIONS, RESTART_COOLDOWN
from vigil.alerts import MIN_CONSECUTIVE, QUANTILE
from vigil.llm import ROLES
from vigil.telemetry import STEP_SECONDS

# The roles a live investigation uses, in the order they act (solo is only for the ablation).
LIVE_ROLES = ("planner", "metrics", "logs", "deploy", "diagnosis", "remediation", "comms")


def policy() -> dict:
    return {
        "actions": [
            {
                "name": name,
                "description": action.description,
                "changes_system": action.changes_system,
                "needs_service": action.needs_service,
            }
            for name, action in ACTIONS.items()
        ],
        "guardrails": {
            "approval_required": True,
            "restart_cooldown_minutes": RESTART_COOLDOWN.total_seconds() / 60,
            "audit_log": True,
        },
        "models": {
            role: [f"{provider}/{model}" for provider, model in ROLES[role]] for role in LIVE_ROLES
        },
        "detector": {
            "method": "robust z-score",
            "quantile": QUANTILE,
            "points_in_a_row": MIN_CONSECUTIVE,
            "every_seconds": STEP_SECONDS,
        },
    }

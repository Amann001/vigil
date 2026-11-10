"""Run investigations, keep them, and record a human's review.

Every step of an investigation is checkpointed, so one paused for review (or interrupted) can be
resumed from any later process. Checkpoints go to Postgres when DATABASE_URL is set in .env (the
Neon free tier), and otherwise to a local SQLite file, data/vigil.db. A readable JSON report of
each investigation is also written to data/investigations/<id>.json.
"""

import json
import os
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

import pandas as pd
from dotenv import load_dotenv
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from shop.config import DATA_DIR, PROJECT_ROOT
from vigil import tracing
from vigil.actions import AuditLog, Executor
from vigil.agents import Context, build_graph
from vigil.alerts import Alert
from vigil.db import direct
from vigil.evidence import Evidence
from vigil.memory import Memory
from vigil.progress import Timeline, follow

DB_PATH = DATA_DIR / "vigil.db"
REPORTS_DIR = DATA_DIR / "investigations"
LIVE_DIR = "live"  # under REPORTS_DIR: the timeline of each investigation as it runs
Verdict = Literal["confirmed", "corrected"]
# Where checkpoints are kept: a Postgres connection URL, or the path of a SQLite file.
Store = str | Path


def default_store() -> Store:
    load_dotenv(PROJECT_ROOT / ".env")
    return os.environ.get("DATABASE_URL") or DB_PATH


def _is_postgres(store: Store) -> bool:
    return isinstance(store, str) and store.startswith(("postgres://", "postgresql://"))


@contextmanager
def open_graph(store: Store | None = None, mode: str = "multi") -> Iterator:
    store = default_store() if store is None else store
    if _is_postgres(store):
        with PostgresSaver.from_conn_string(direct(store)) as saver:
            saver.setup()  # creates the checkpoint tables on first use; a no-op afterwards
            yield build_graph(saver, mode)
        return
    path = Path(store)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, check_same_thread=False)
    try:
        yield build_graph(SqliteSaver(connection), mode)
    finally:
        connection.close()


def product_memory() -> Memory:
    """Vigil's memory: in Postgres when a database is configured, with the runbooks loaded."""
    from vigil.memory import load_runbooks, open_memory

    store = default_store()
    memory = open_memory(store if _is_postgres(store) else None)
    memory.add(load_runbooks())  # an upsert: runbook edits are picked up on the next run
    return memory


def _config(investigation_id: str) -> dict:
    return {"configurable": {"thread_id": investigation_id}}


def _write_report(report: dict, reports_dir: Path) -> None:
    reports_dir.mkdir(parents=True, exist_ok=True)
    path = reports_dir / f"{report['id']}.json"
    path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")


def investigate(
    investigation_id: str,
    alert: Alert,
    evidence: Evidence,
    memory: Memory | None = None,
    store: Store | None = None,
    reports_dir: Path = REPORTS_DIR,
    mode: str = "multi",
    callbacks: list | None = None,
) -> dict:
    """Investigate an alert until the diagnosis and the proposed fix await human review.

    An investigation that was interrupted part-way (the process stopped) continues from its
    last checkpoint. One that already reached review is started again from scratch.
    """
    started = time.monotonic()
    config = _config(investigation_id)
    context = Context(evidence, memory=memory)
    traced = tracing.run_config(investigation_id, "investigation")
    if callbacks:  # e.g. token counting in the evaluation
        traced = traced | {"callbacks": traced.get("callbacks", []) + callbacks}
    timeline = Timeline(
        reports_dir / LIVE_DIR / f"{investigation_id}.json",
        {
            "id": investigation_id,
            "alert": alert.describe(),
            "alert_at": alert.detected_at.isoformat(),
            "signals": alert.to_dict()["signals"],
            "started_at": pd.Timestamp.now(tz="UTC").isoformat(timespec="seconds"),
        },
    )
    with open_graph(store, mode) as graph:
        pending = graph.get_state(config).next
        resumed = bool(pending) and pending != ("review",)
        try:
            if resumed:
                # Passing new input would restart the graph and skip the interrupted steps (an
                # interrupted run lost its second round of questions this way); None continues.
                state = follow(graph, None, config | traced, context, timeline)
            else:
                graph.checkpointer.delete_thread(investigation_id)  # no-op for a new one
                start = {
                    "id": investigation_id,
                    "alert": alert.describe(),
                    "alert_at": alert.detected_at.isoformat(),
                }
                state = follow(graph, start, config | traced, context, timeline)
        except Exception:
            timeline.finish("failed")
            raise
    tracing.flush()
    report = {
        "id": investigation_id,
        "status": "awaiting review",
        "resumed_from_checkpoint": resumed,
        "alert_at": alert.detected_at.isoformat(),
        "investigated_at": pd.Timestamp.now(tz="UTC").isoformat(timespec="seconds"),
        "seconds": round(time.monotonic() - started, 1),
        "alert": state["alert"],
        "findings": state.get("findings", []),
        "models": state.get("models", []),
        "diagnosis": state["diagnosis"],
        "recalled": [r["id"] for r in state.get("recalled", [])],
        "proposal": state.get("proposal"),
        "signals": timeline.data["signals"],
        "timeline": timeline.finish("awaiting review"),
    }
    _write_report(report, reports_dir)
    return report


def review(
    investigation_id: str,
    verdict: Verdict,
    notes: str = "",
    approve: bool = False,
    by: str = "reviewer",
    instead: dict | None = None,
    memory: Memory | None = None,
    executor: Executor | None = None,
    store: Store | None = None,
    reports_dir: Path = REPORTS_DIR,
    audit: AuditLog | None = None,
) -> dict:
    """Record a human's decision on a paused investigation and finish it: the proposal runs
    only if approved (and allowed by the guardrails), then the incident report is written and
    the incident is remembered."""
    report_path = reports_dir / f"{investigation_id}.json"
    if not report_path.exists():
        raise KeyError(f"No investigation {investigation_id!r}")
    decision = {
        "verdict": verdict,
        "notes": notes,
        "approve": approve,
        "instead": instead,
        "by": by,
        "at": pd.Timestamp.now(tz="UTC").isoformat(timespec="seconds"),
    }
    context = Context(None, memory=memory, executor=executor, audit=audit)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    timeline = Timeline(
        reports_dir / LIVE_DIR / f"{investigation_id}.json",
        {k: report.get(k) for k in ("id", "alert", "alert_at", "signals")},
        status="acting",
        events=report.get("timeline", [])
        + [{"at": decision["at"], "step": "decision", "review": decision}],
    )
    with open_graph(store) as graph:
        if graph.get_state(_config(investigation_id)).next != ("review",):
            timeline.finish(report["status"])
            raise ValueError(f"Investigation {investigation_id!r} is not awaiting review")
        traced = tracing.run_config(investigation_id, "review")
        config = _config(investigation_id) | traced
        try:
            state = follow(graph, Command(resume=decision), config, context, timeline)
        except Exception:
            timeline.finish("awaiting review")
            raise
    tracing.flush()
    report |= {
        "status": verdict,
        "review": decision,
        "action": state.get("action"),
        "incident_report": state.get("report"),
        "models": state.get("models", report["models"]),
        "timeline": timeline.finish(verdict),
    }
    _write_report(report, reports_dir)
    if report["incident_report"]:
        (reports_dir / f"{investigation_id}.md").write_text(
            report["incident_report"], encoding="utf-8"
        )
    return report


def load_reports(reports_dir: Path = REPORTS_DIR) -> list[dict]:
    if not reports_dir.exists():
        return []
    reports = [json.loads(p.read_text(encoding="utf-8")) for p in reports_dir.glob("*.json")]
    return sorted(reports, key=lambda r: r["alert_at"])


def format_report(report: dict) -> str:
    d = report["diagnosis"]
    lines = [
        f"Investigation {report['id']}  [{report['status']}]",
        f"Alert at {report['alert_at']}, investigated in {report['seconds']} s",
        "",
        f"Root cause: {d['root_cause_service']} ({d['category']}), confidence {d['confidence']}",
        d["summary"],
        "",
        "Evidence:",
        *(f"  - {item}" for item in d["evidence"]),
        f"Affected: {', '.join(d['affected_services']) or '-'}",
        "Next steps:",
        *(f"  - {item}" for item in d["next_steps"]),
        "",
        "Models: " + ", ".join(dict.fromkeys(report["models"])),
    ]
    if proposal := report.get("proposal"):
        target = f" {proposal['service']}" if proposal.get("service") else ""
        cited = ", ".join(proposal.get("cited_incidents") or []) or "none"
        lines += [
            "",
            f"Proposed fix: {proposal['action']}{target}",
            f"  why: {proposal['rationale']}",
            f"  runbook: {proposal.get('runbook') or '-'}; similar past incidents: {cited}",
        ]
    if "review" in report:
        lines.append(f"Review: {report['review']['verdict']} {report['review']['notes']}".rstrip())
    if action := report.get("action"):
        reasons = "; ".join(action.get("reasons") or [])
        dry = " (dry run)" if action.get("dry_run") else ""
        lines.append(f"Action: {action['outcome']}{dry} {reasons}".rstrip())
    return "\n".join(lines)

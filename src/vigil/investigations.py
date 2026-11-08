"""Run investigations, keep them, and record a human's review.

Checkpoints live in a SQLite database (data/vigil.db), so an investigation paused for review
can be resumed from any later process. A readable JSON report of each investigation is also
written to data/investigations/<id>.json.
"""

import json
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

import pandas as pd
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from shop.config import DATA_DIR
from vigil.agents import Context, build_graph
from vigil.alerts import Alert
from vigil.evidence import Evidence

DB_PATH = DATA_DIR / "vigil.db"
REPORTS_DIR = DATA_DIR / "investigations"
Verdict = Literal["confirmed", "corrected"]


@contextmanager
def open_graph(db_path: Path = DB_PATH) -> Iterator:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path, check_same_thread=False)
    try:
        yield build_graph(SqliteSaver(connection))
    finally:
        connection.close()


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
    db_path: Path = DB_PATH,
    reports_dir: Path = REPORTS_DIR,
) -> dict:
    """Investigate an alert until the diagnosis is ready for human review.

    An investigation that was interrupted part-way (the process stopped) continues from its
    last checkpoint. One that already reached review is started again from scratch.
    """
    started = time.monotonic()
    config = _config(investigation_id)
    with open_graph(db_path) as graph:
        pending = graph.get_state(config).next
        resumed = bool(pending) and pending != ("review",)
        if resumed:
            # Passing new input would restart the graph and skip the interrupted steps (an
            # interrupted run lost its second round of questions this way); None continues them.
            state = graph.invoke(None, config, context=Context(evidence))
        else:
            graph.checkpointer.delete_thread(investigation_id)  # no-op for a new investigation
            state = graph.invoke({"alert": alert.describe()}, config, context=Context(evidence))
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
    }
    _write_report(report, reports_dir)
    return report


def review(
    investigation_id: str,
    verdict: Verdict,
    notes: str = "",
    db_path: Path = DB_PATH,
    reports_dir: Path = REPORTS_DIR,
) -> dict:
    """Record a human's verdict on a paused investigation and finish it."""
    report_path = reports_dir / f"{investigation_id}.json"
    if not report_path.exists():
        raise KeyError(f"No investigation {investigation_id!r}")
    decision = {
        "verdict": verdict,
        "notes": notes,
        "at": pd.Timestamp.now(tz="UTC").isoformat(timespec="seconds"),
    }
    with open_graph(db_path) as graph:
        if not graph.get_state(_config(investigation_id)).next:
            raise ValueError(f"Investigation {investigation_id!r} is not awaiting review")
        graph.invoke(Command(resume=decision), _config(investigation_id), context=Context(None))
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report |= {"status": verdict, "review": decision}
    _write_report(report, reports_dir)
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
    if "review" in report:
        lines.append(f"Review: {report['review']['verdict']} {report['review']['notes']}".rstrip())
    return "\n".join(lines)

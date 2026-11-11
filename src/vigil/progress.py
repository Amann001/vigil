"""The timeline of an investigation, written step by step while it runs.

The war-room UI shows an investigation as it happens: which questions the supervisor asked, which
specialist answered, the diagnosis, the proposal. Each finished graph step becomes one event in
data/investigations/live/<id>.json, rewritten after every step; the finished report keeps the
whole timeline. Events hold only what the steps produced, never anything the agents were not
shown.
"""

import json
from pathlib import Path

import pandas as pd

from vigil.archive import write_text

Event = dict


def _now() -> str:
    return pd.Timestamp.now(tz="UTC").isoformat(timespec="milliseconds")


def event(step: str, update: dict | None) -> Event | None:
    """The event for one graph step's update, or None for steps with nothing to show."""
    update = update or {}
    at = {"at": _now(), "step": step}
    if step == "plan":
        return at | {"round": update.get("round"), "tasks": update.get("tasks", [])}
    if step in ("specialist", "solo"):
        (finding,) = update.get("findings", [{}])
        return at | {
            "agent": finding.get("agent"),
            "question": finding.get("question"),
            "tools": [call["name"] for call in finding.get("tool_calls", [])],
            "report": finding.get("report"),
        }
    if step == "diagnose":
        return at | {"diagnosis": update.get("diagnosis")}
    if step == "recall":
        return at | {"recalled": [r["id"] for r in update.get("recalled", [])]}
    if step == "propose":
        return at | {"proposal": update.get("proposal")}
    if step == "__interrupt__":
        return {"at": at["at"], "step": "review"}
    if step == "act":
        return at | {"action": update.get("action")}
    if step == "report":
        return at
    return None


class Timeline:
    """The events of one investigation, kept in a file other processes (the API) can read."""

    def __init__(
        self, path: Path, header: dict, status: str = "investigating", events: list | None = None
    ) -> None:
        self.path = path
        self.data = header | {"status": status, "events": list(events or [])}
        self._write()

    def add(self, step: str, update: dict | None) -> None:
        if (item := event(step, update)) is not None:
            self.data["events"].append(item)
            self._write()

    def finish(self, status: str) -> list[Event]:
        self.data["status"] = status
        self._write()
        return self.data["events"]

    def _write(self) -> None:
        # Written whole then renamed (a reader never sees half a file), and archived.
        write_text(self.path, json.dumps(self.data, default=str))


def follow(graph, graph_input, config: dict, context, timeline: Timeline) -> dict:
    """Run the graph until it pauses or ends, adding each finished step to the timeline, and
    return its state (as invoke would)."""
    for chunk in graph.stream(graph_input, config, context=context, stream_mode="updates"):
        for step, update in chunk.items():
            timeline.add(step, update if isinstance(update, dict) else None)
    return graph.get_state(config).values

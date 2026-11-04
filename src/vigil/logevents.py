"""Turn the shop's JSON logs into events and per-interval log features.

Each log line becomes an event with a template key: its level, logger and Drain template, so
"order failed" from orders is one kind of event however many times it occurs. Per interval Vigil
then counts warnings, errors, and lines whose kind was never seen during training. A brand-new
kind of error is often the earliest sign of an incident.
"""

import json
from pathlib import Path

import pandas as pd

from vigil.logparse import LogParser

SERVICES = ["storefront", "orders", "payments", "inventory"]
EVENT_COLUMNS = ["timestamp", "service", "level", "template"]
# The shop logs fixed messages and puts values in separate fields, so a short message differing
# by one word is a different event ("order confirmed" vs "order failed"). Drain's usual 0.4
# similarity merges those into "order <*>", which would hide a brand-new error such as
# "order exploded"; 0.7 keeps them apart while still merging lines that differ in one number.
SIMILARITY = 0.7


def read_events(log_dir: Path) -> pd.DataFrame:
    """Every JSON log line in `log_dir`, in time order, with its template key."""
    records = []
    for path in sorted(log_dir.glob("*.log*")):
        with path.open(encoding="utf-8") as file:
            records.extend(json.loads(line) for line in file if line.strip())
    if not records:
        return pd.DataFrame(columns=EVENT_COLUMNS)

    events = pd.DataFrame(records)
    events["timestamp"] = pd.to_datetime(events["timestamp"], utc=True, format="ISO8601")
    events = events.sort_values("timestamp", kind="stable").reset_index(drop=True)
    parser = LogParser(similarity=SIMILARITY)
    groups = parser.parse(events["message"].astype(str))
    templates = parser.templates
    events["template"] = [
        f"{level} {logger}: {templates[group]}"
        for level, logger, group in zip(events["level"], events["logger"], groups, strict=True)
    ]
    return events[EVENT_COLUMNS]


def log_features(
    events: pd.DataFrame,
    index: pd.DatetimeIndex,
    known_templates: set[str],
) -> pd.DataFrame:
    """Per interval of `index` and per service: warnings, errors, and never-seen-before lines.

    Each event is counted in the interval that starts at or before it.
    """
    step = index.freq or (index[1] - index[0])
    buckets = events["timestamp"].dt.floor(step)
    columns = {}
    for service in SERVICES:
        mine = events["service"] == service
        counts = {
            "log_warnings": mine & (events["level"] == "WARNING"),
            "log_errors": mine & events["level"].isin(["ERROR", "CRITICAL"]),
            "log_new_templates": mine & ~events["template"].isin(known_templates),
        }
        for name, selected in counts.items():
            per_bucket = selected.groupby(buckets).sum()
            columns[f"{service}.{name}"] = per_bucket.reindex(index, fill_value=0).astype(float)
    return pd.DataFrame(columns, index=index)


def templates_seen(events: pd.DataFrame, before: pd.Timestamp) -> set[str]:
    """Every kind of log line that occurred before `before`, i.e. during training."""
    return set(events.loc[events["timestamp"] < before, "template"])

"""Turn the fault-injection ledger into labelled incident windows.

Used only for training data selection and evaluation. The ledger is ground truth that Vigil's
agents and detectors must never see while they are making decisions.
"""

import json
from dataclasses import dataclass
from pathlib import Path

import pandas as pd


@dataclass(frozen=True)
class Incident:
    id: int
    service: str
    fault: str
    start: pd.Timestamp
    end: pd.Timestamp
    settings: dict


def load_ledger(path: Path) -> list[dict]:
    """Ledger entries in order. No ledger means no incident has been injected yet."""
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def incident_windows(entries: list[dict], campaign_end: pd.Timestamp) -> list[Incident]:
    """Each injection lasts until its own duration elapses or the service is cleared/restarted.

    Faults with no duration and no recorded recovery last until the campaign ended.
    """
    incidents = []
    for position, entry in enumerate(entries):
        if entry["action"] != "inject":
            continue
        start = pd.Timestamp(entry["timestamp"])
        fault = entry["fault"]
        if fault.get("duration_seconds"):
            end = start + pd.Timedelta(seconds=fault["duration_seconds"])
        else:
            recovery = next(
                (
                    later
                    for later in entries[position + 1 :]
                    if later["service"] == entry["service"]
                    and later["action"] in ("clear", "restart")
                ),
                None,
            )
            end = pd.Timestamp(recovery["timestamp"]) if recovery else campaign_end
        settings = {k: v for k, v in fault.items() if k not in ("fault", "duration_seconds")}
        incidents.append(
            Incident(len(incidents) + 1, entry["service"], fault["fault"], start, end, settings)
        )
    return incidents


def label(index: pd.DatetimeIndex, incidents: list[Incident]) -> pd.DataFrame:
    """For each timestamp: which incident (if any) was active, on which service, of which kind."""
    labels = pd.DataFrame(
        {"incident_id": 0, "incident_service": "", "incident_fault": ""}, index=index
    )
    for incident in incidents:
        active = (index >= incident.start) & (index < incident.end)
        labels.loc[active, "incident_id"] = incident.id
        labels.loc[active, "incident_service"] = incident.service
        labels.loc[active, "incident_fault"] = incident.fault
    labels["anomaly"] = labels["incident_id"] > 0
    return labels

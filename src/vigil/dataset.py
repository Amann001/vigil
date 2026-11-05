"""Export a finished data-collection campaign as a labelled dataset.

Writes to data/datasets/vigil/<campaign start>/:
- metrics.csv.gz : one row per 5 s, one column per feature, plus incident labels
- logs.csv.gz    : every service log line with its template key
- raw_logs/      : the original JSON log lines, so agents can be replayed on the campaign
- incidents.json : each incident's service, fault, settings and time window
- meta.json      : the campaign settings and where training data ends

Run it with: uv run python -m vigil.dataset
"""

import argparse
import gzip
import json
from pathlib import Path

import httpx
import pandas as pd

from shop.config import DATA_DIR
from vigil.incidents import incident_windows, label, load_ledger
from vigil.logevents import read_events
from vigil.telemetry import PROMETHEUS_URL, fetch_features

CHAOS_DIR = DATA_DIR / "chaos"
LOG_DIR = DATA_DIR / "logs"
OUTPUT_DIR = DATA_DIR / "datasets" / "vigil"


def campaign_end(meta: dict) -> pd.Timestamp:
    for key in ("finished_at", "interrupted_at", "planned_end_at"):
        if key in meta:
            return pd.Timestamp(meta[key])
    raise ValueError("campaign.json has no end time")


def archive_raw_logs(log_dir: Path, target: Path, start: pd.Timestamp, end: pd.Timestamp) -> None:
    """Copy each service's JSON log lines from the campaign into raw_logs/<service>.jsonl.gz.

    Live log files rotate and are appended to by later runs; this keeps the campaign's own lines.
    """
    output = target / "raw_logs"
    output.mkdir(parents=True, exist_ok=True)
    by_service: dict[str, list[tuple[pd.Timestamp, str]]] = {}
    for path in sorted(log_dir.glob("*.log*")):
        with path.open(encoding="utf-8") as file:
            for line in file:
                if not line.strip():
                    continue
                entry = json.loads(line)
                timestamp = pd.Timestamp(entry["timestamp"])
                if start <= timestamp <= end:
                    by_service.setdefault(entry["service"], []).append((timestamp, line))
    for service, lines in by_service.items():
        lines.sort(key=lambda pair: pair[0])
        with gzip.open(output / f"{service}.jsonl.gz", "wt", encoding="utf-8") as file:
            file.writelines(line.rstrip("\r\n") + "\n" for _, line in lines)


def export(
    chaos_dir: Path, output_dir: Path, client: httpx.Client, log_dir: Path = LOG_DIR
) -> Path:
    meta = json.loads((chaos_dir / "campaign.json").read_text(encoding="utf-8"))
    start, end = pd.Timestamp(meta["started_at"]), campaign_end(meta)
    incidents = incident_windows(load_ledger(chaos_dir / "ledger.jsonl"), end)

    features = fetch_features(start.to_pydatetime(), end.to_pydatetime(), client)
    table = features.join(label(features.index, incidents))

    target = output_dir / start.strftime("%Y%m%dT%H%M%SZ")
    target.mkdir(parents=True, exist_ok=True)
    table.to_csv(target / "metrics.csv.gz", float_format="%.6g")
    events = read_events(log_dir)
    in_campaign = (events["timestamp"] >= start) & (events["timestamp"] <= end)
    events[in_campaign].to_csv(target / "logs.csv.gz", index=False)
    archive_raw_logs(log_dir, target, start, end)
    (target / "incidents.json").write_text(
        json.dumps(
            [
                {
                    "id": i.id,
                    "service": i.service,
                    "fault": i.fault,
                    "settings": i.settings,
                    "start": i.start.isoformat(),
                    "end": i.end.isoformat(),
                }
                for i in incidents
            ],
            indent=2,
        )
    )
    (target / "meta.json").write_text(
        json.dumps({**meta, "rows": len(table), "features": list(features.columns)}, indent=2)
    )
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description="Export a campaign as a labelled dataset.")
    parser.add_argument("--prometheus", default=PROMETHEUS_URL)
    args = parser.parse_args()
    with httpx.Client(base_url=args.prometheus, timeout=60) as client:
        target = export(CHAOS_DIR, OUTPUT_DIR, client)
    table = pd.read_csv(target / "metrics.csv.gz", index_col="timestamp")
    print(f"Exported {len(table)} rows x {table.shape[1]} columns to {target}")
    print(f"Anomalous rows: {table['anomaly'].sum()} ({table['anomaly'].mean():.1%})")


if __name__ == "__main__":
    main()

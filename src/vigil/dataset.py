"""Export a finished data-collection campaign as a labelled dataset.

Writes to data/datasets/vigil/<campaign start>/:
- metrics.csv.gz : one row per 5 s, one column per feature, plus incident labels
- incidents.json : each incident's service, fault, settings and time window
- meta.json      : the campaign settings and where training data ends

Run it with: uv run python -m vigil.dataset
"""

import argparse
import json
from pathlib import Path

import httpx
import pandas as pd

from shop.config import DATA_DIR
from vigil.incidents import incident_windows, label, load_ledger
from vigil.telemetry import PROMETHEUS_URL, fetch_features

CHAOS_DIR = DATA_DIR / "chaos"
OUTPUT_DIR = DATA_DIR / "datasets" / "vigil"


def campaign_end(meta: dict) -> pd.Timestamp:
    for key in ("finished_at", "interrupted_at", "planned_end_at"):
        if key in meta:
            return pd.Timestamp(meta[key])
    raise ValueError("campaign.json has no end time")


def export(chaos_dir: Path, output_dir: Path, client: httpx.Client) -> Path:
    meta = json.loads((chaos_dir / "campaign.json").read_text(encoding="utf-8"))
    start, end = pd.Timestamp(meta["started_at"]), campaign_end(meta)
    incidents = incident_windows(load_ledger(chaos_dir / "ledger.jsonl"), end)

    features = fetch_features(start.to_pydatetime(), end.to_pydatetime(), client)
    table = features.join(label(features.index, incidents))

    target = output_dir / start.strftime("%Y%m%dT%H%M%SZ")
    target.mkdir(parents=True, exist_ok=True)
    table.to_csv(target / "metrics.csv.gz", float_format="%.6g")
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

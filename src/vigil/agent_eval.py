"""Score the agents' diagnoses on a recorded campaign against what was really injected.

For each alert the detector raised on the campaign, the agents investigate a replay of the shop
as it was at that moment. Only afterwards does this module read the campaign's incident labels
(the agents never see them) and check the diagnosis: the right root-cause service, and the
right kind of failure.

Run it with: uv run python -m vigil.agent_eval [--rerun]
Investigations already on disk are reused, because free-tier model quotas are small.
"""

import argparse
import json
from collections import Counter
from pathlib import Path

import pandas as pd

from shop.config import DATA_DIR
from vigil.alerts import Alert, AlertDetector
from vigil.evidence import ReplayEvidence
from vigil.investigations import REPORTS_DIR, investigate
from vigil.shop_benchmark import GRACE, latest_dataset, load

RESULTS_DIR = DATA_DIR / "results"
# What a correct diagnosis category is for each injected fault.
EXPECTED_CATEGORY = {
    "crash": "service_crash",
    "leak": "memory_leak",
    "latency": "slow_responses",
    "errors": "error_responses",
}


def replay_alerts(dataset_dir: Path) -> list[Alert]:
    """The alerts the detector raised during the campaign, after its training warm-up."""
    data = load(dataset_dir)
    training = (data.features.index >= data.train_start) & (data.features.index < data.train_end)
    detector = AlertDetector().fit(data.features[training])
    return [a for a in detector.alerts(data.features) if a.detected_at >= data.train_end]


def investigation_id(dataset_dir: Path, number: int) -> str:
    return f"replay-{dataset_dir.name}-{number:02d}"


def matching_incident(alert_at: pd.Timestamp, incidents: list[dict]) -> dict | None:
    for incident in incidents:
        start, end = pd.Timestamp(incident["start"]), pd.Timestamp(incident["end"])
        if start <= alert_at <= end + GRACE:
            return incident
    return None


def score(reports: list[dict], incidents: list[dict]) -> dict:
    rows = []
    for report in reports:
        incident = matching_incident(pd.Timestamp(report["alert_at"]), incidents)
        diagnosis = report["diagnosis"]
        expected_service = incident["service"] if incident else None
        expected_category = EXPECTED_CATEGORY[incident["fault"]] if incident else None
        rows.append(
            {
                "investigation": report["id"],
                "incident": incident["id"] if incident else None,
                "expected": f"{expected_service} {expected_category}"
                if incident
                else "no incident",
                "diagnosed": f"{diagnosis['root_cause_service']} {diagnosis['category']}",
                "service_correct": diagnosis["root_cause_service"] == expected_service,
                "category_correct": diagnosis["category"] == expected_category,
                "confidence": diagnosis["confidence"],
                "seconds": report["seconds"],
                "diagnosis_model": next(
                    (m.split(": ", 1)[1] for m in report["models"] if m.startswith("diagnosis")),
                    None,
                ),
            }
        )
    total = len(rows)
    both = sum(r["service_correct"] and r["category_correct"] for r in rows)
    return {
        "investigations": total,
        "service_accuracy": sum(r["service_correct"] for r in rows) / total if total else None,
        "category_accuracy": sum(r["category_correct"] for r in rows) / total if total else None,
        "fully_correct": both,
        "median_seconds": float(pd.Series([r["seconds"] for r in rows]).median()) if rows else None,
        "diagnosis_models": dict(Counter(r["diagnosis_model"] for r in rows)),
        "rows": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Score agent diagnoses on a recorded campaign.")
    parser.add_argument("dataset", nargs="?", type=Path, help="defaults to the latest export")
    parser.add_argument("--rerun", action="store_true", help="investigate again even if done")
    args = parser.parse_args()
    dataset_dir = args.dataset or latest_dataset()

    reports = []
    alerts = replay_alerts(dataset_dir)
    for number, alert in enumerate(alerts, start=1):
        identifier = investigation_id(dataset_dir, number)
        path = REPORTS_DIR / f"{identifier}.json"
        if path.exists() and not args.rerun:
            reports.append(json.loads(path.read_text(encoding="utf-8")))
            continue
        print(f"Investigating alert {number}/{len(alerts)} at {alert.detected_at:%H:%M:%S} ...")
        evidence = ReplayEvidence(dataset_dir, as_of=alert.detected_at)
        reports.append(investigate(identifier, alert, evidence))

    # Ground truth is read only now, after every investigation has finished.
    incidents = json.loads((dataset_dir / "incidents.json").read_text(encoding="utf-8"))
    result = score(reports, incidents)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_DIR / "agents.json").write_text(json.dumps(result, indent=2))

    print(f"\n{'#':>3}  {'expected':<28}{'diagnosed':<28}{'service':>8}{'kind':>6}{'sec':>6}")
    for row in result["rows"]:
        mark = {True: "yes", False: "no"}
        print(
            f"{row['incident'] or '-':>3}  {row['expected']:<28}{row['diagnosed']:<28}"
            f"{mark[row['service_correct']]:>8}{mark[row['category_correct']]:>6}"
            f"{row['seconds']:>6.0f}"
        )
    print(
        f"\nRoot-cause service correct: {result['service_accuracy']:.0%}; "
        f"kind of failure correct: {result['category_accuracy']:.0%}; "
        f"both: {result['fully_correct']}/{result['investigations']}; "
        f"median {result['median_seconds']:.0f} s per investigation"
    )
    print(f"Diagnosis written by: {result['diagnosis_models']}")


if __name__ == "__main__":
    main()

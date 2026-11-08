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
from vigil.actions import AuditLog, DryRunExecutor
from vigil.alerts import Alert, AlertDetector
from vigil.evidence import ReplayEvidence
from vigil.investigations import REPORTS_DIR, investigate, review
from vigil.memory import Encoder, LocalStore, Memory, incident_document, load_runbooks
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


REVIEWER = "simulated reviewer"


def simulated_review(report: dict, incident: dict | None) -> dict:
    """What a reviewer who knows the injected fault would decide: confirm a right diagnosis or
    correct a wrong one, and approve only a restart of the real root-cause service (every
    runbook's fix for the faults injected here)."""
    if incident is None:
        return {"verdict": "corrected", "notes": "There was no incident.", "approve": False}
    diagnosis, proposal = report["diagnosis"], report["proposal"]
    expected = EXPECTED_CATEGORY[incident["fault"]]
    right = (
        diagnosis["root_cause_service"] == incident["service"] and diagnosis["category"] == expected
    )
    notes = "" if right else f"The root cause was {incident['service']} ({expected})."
    approve = proposal["action"] == "restart_service" and proposal["service"] == incident["service"]
    return {"verdict": "confirmed" if right else "corrected", "notes": notes, "approve": approve}


def _truth(report: dict, incidents: list[dict]) -> dict | None:
    return matching_incident(pd.Timestamp(report["alert_at"]), incidents)


def score(reports: list[dict], incidents: list[dict]) -> dict:
    kinds = {r["id"]: (i["service"], i["fault"]) for r in reports if (i := _truth(r, incidents))}
    rows = []
    for report in reports:
        incident = _truth(report, incidents)
        diagnosis = report["diagnosis"]
        proposal = report.get("proposal") or {}
        expected_service = incident["service"] if incident else None
        expected_category = EXPECTED_CATEGORY[incident["fault"]] if incident else None
        kind = kinds.get(report["id"])
        cited = proposal.get("cited_incidents") or []
        earlier_alike = [
            other["id"]
            for other in reports
            if other["alert_at"] < report["alert_at"] and kinds.get(other["id"]) == kind
        ]
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
                "proposed": f"{proposal.get('action')} {proposal.get('service') or ''}".strip(),
                "proposal_correct": proposal.get("action") == "restart_service"
                and proposal.get("service") == expected_service,
                "cited": cited,
                "cited_alike": [c for c in cited if kinds.get(c) == kind],
                "earlier_alike": earlier_alike,
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
    with_alike = [r for r in rows if r["earlier_alike"]]
    return {
        "investigations": total,
        "service_accuracy": sum(r["service_correct"] for r in rows) / total if total else None,
        "category_accuracy": sum(r["category_correct"] for r in rows) / total if total else None,
        "fully_correct": both,
        "proposal_accuracy": sum(r["proposal_correct"] for r in rows) / total if total else None,
        # Of the investigations that had an earlier incident of the same kind to remember, how
        # many proposals cited one; and how many citations were of the same kind.
        "cited_when_possible": sum(bool(r["cited_alike"]) for r in with_alike),
        "could_cite": len(with_alike),
        "citations": sum(len(r["cited"]) for r in rows),
        "citations_alike": sum(len(r["cited_alike"]) for r in rows),
        "median_seconds": float(pd.Series([r["seconds"] for r in rows]).median()) if rows else None,
        "diagnosis_models": dict(Counter(r["diagnosis_model"] for r in rows)),
        "rows": rows,
    }


def evaluation_memory() -> Memory:
    """A memory of its own, so evaluation runs never mix with Vigil's real memory."""
    encoder = Encoder()
    memory = Memory(LocalStore(), encoder.embed, encoder.rerank)
    memory.add(load_runbooks())
    return memory


def main() -> None:
    parser = argparse.ArgumentParser(description="Score agent diagnoses on a recorded campaign.")
    parser.add_argument("dataset", nargs="?", type=Path, help="defaults to the latest export")
    parser.add_argument("--rerun", action="store_true", help="investigate again even if done")
    args = parser.parse_args()
    dataset_dir = args.dataset or latest_dataset()
    incidents = json.loads((dataset_dir / "incidents.json").read_text(encoding="utf-8"))
    memory = evaluation_memory()
    audit = AuditLog(RESULTS_DIR / "agent_eval_audit.jsonl")

    reports = []
    alerts = replay_alerts(dataset_dir)
    for number, alert in enumerate(alerts, start=1):
        identifier = investigation_id(dataset_dir, number)
        path = REPORTS_DIR / f"{identifier}.json"
        done = path.exists() and json.loads(path.read_text(encoding="utf-8")).get("action")
        if done and not args.rerun:
            report = json.loads(path.read_text(encoding="utf-8"))
            memory.add([incident_document(report)])  # as if reviewed now: later ones recall it
            reports.append(report)
            continue
        print(f"Investigating alert {number}/{len(alerts)} at {alert.detected_at:%H:%M:%S} ...")
        evidence = ReplayEvidence(dataset_dir, as_of=alert.detected_at)
        report = investigate(identifier, alert, evidence, memory=memory)
        # The reviewer sees the truth only after the investigation has finished, as a human
        # would; it reaches later investigations only through memory, as a human's would.
        decision = simulated_review(report, _truth(report, incidents))
        reports.append(
            review(
                identifier,
                decision["verdict"],
                decision["notes"],
                approve=decision["approve"],
                by=REVIEWER,
                memory=memory,
                executor=DryRunExecutor(),
                audit=audit,
            )
        )

    result = score(reports, incidents)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_DIR / "agents.json").write_text(json.dumps(result, indent=2))

    mark = {True: "yes", False: "no"}
    print(
        f"\n{'#':>3}  {'expected':<28}{'diagnosed':<28}{'right':>6}"
        f"{'  proposed fix':<28}{'right':>6}  cited"
    )
    for row in result["rows"]:
        right = row["service_correct"] and row["category_correct"]
        print(
            f"{row['incident'] or '-':>3}  {row['expected']:<28}{row['diagnosed']:<28}"
            f"{mark[right]:>6}  {row['proposed']:<26}{mark[row['proposal_correct']]:>6}  "
            f"{', '.join(c.rsplit('-', 1)[-1] for c in row['cited']) or '-'}"
        )
    print(
        f"\nDiagnosis fully correct: {result['fully_correct']}/{result['investigations']}; "
        f"fix correct: {result['proposal_accuracy']:.0%}; "
        f"cited an earlier incident of the same kind: "
        f"{result['cited_when_possible']}/{result['could_cite']} times it could; "
        f"{result['citations_alike']}/{result['citations']} citations of the same kind; "
        f"median {result['median_seconds']:.0f} s"
    )
    print(f"Diagnosis written by: {result['diagnosis_models']}")


if __name__ == "__main__":
    main()

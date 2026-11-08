"""Measure how well memory retrieves the right runbook, for each way of searching.

Queries are what Vigil searches with during the recorded campaign's 11 investigations: the
alert text (searched before investigating) and the diagnosis summary (searched before proposing
a fix). The relevant runbook for each comes from the injected fault: a crash needs
service-down, a leak memory-leak, latency high-latency, errors error-spike. The labels are used
only here, to score.

Reported per search mode (keyword, vector, hybrid, hybrid + rerank):
- recall@1 and recall@3: how often the relevant runbook is first, or in the top three;
- MRR (mean reciprocal rank): 1 if first, 1/2 if second, ..., averaged.

Run it with: uv run python -m vigil.memory_eval
"""

import json
import time
from pathlib import Path

from shop.config import DATA_DIR
from vigil.agent_eval import investigation_id, matching_incident, replay_alerts
from vigil.investigations import REPORTS_DIR, default_store
from vigil.memory import Memory, load_runbooks, open_memory
from vigil.shop_benchmark import latest_dataset

RESULTS_DIR = DATA_DIR / "results"
RELEVANT = {
    "crash": "service-down",
    "leak": "memory-leak",
    "latency": "high-latency",
    "errors": "error-spike",
}
MODES = ("keyword", "vector", "hybrid", "hybrid+rerank")
DEPTH = 10  # ranks beyond this count as not found


def queries(dataset_dir: Path, reports_dir: Path = REPORTS_DIR) -> list[dict]:
    incidents = json.loads((dataset_dir / "incidents.json").read_text(encoding="utf-8"))
    found = []
    for number, alert in enumerate(replay_alerts(dataset_dir), start=1):
        incident = matching_incident(alert.detected_at, incidents)
        report_path = reports_dir / f"{investigation_id(dataset_dir, number)}.json"
        if incident is None or not report_path.exists():
            continue
        report = json.loads(report_path.read_text(encoding="utf-8"))
        relevant = RELEVANT[incident["fault"]]
        found.append({"source": "alert", "text": alert.describe(), "relevant": relevant})
        summary = report["diagnosis"]["summary"]
        found.append({"source": "diagnosis", "text": summary, "relevant": relevant})
    return found


def evaluate(memory: Memory, cases: list[dict]) -> dict:
    results = {}
    for mode in MODES:
        for source in ("alert", "diagnosis"):
            selected = [c for c in cases if c["source"] == source]
            ranks, started = [], time.monotonic()
            for case in selected:
                hits = memory.search(case["text"], kinds=["runbook"], limit=DEPTH, mode=mode)
                ids = [h.document.id for h in hits]
                ranks.append(ids.index(case["relevant"]) + 1 if case["relevant"] in ids else None)
            n = len(ranks)
            results[f"{mode}|{source}"] = {
                "queries": n,
                "recall@1": sum(r == 1 for r in ranks) / n,
                "recall@3": sum(r is not None and r <= 3 for r in ranks) / n,
                "mrr": sum(1 / r for r in ranks if r) / n,
                "ms_per_query": round(1000 * (time.monotonic() - started) / n),
            }
    return results


def main() -> None:
    store = default_store()
    memory = open_memory(store if isinstance(store, str) else None)
    memory.add(load_runbooks())
    cases = queries(latest_dataset())
    results = evaluate(memory, cases)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_DIR / "memory.json").write_text(json.dumps(results, indent=2))

    print(f"{'mode':<15}{'query':<11}{'recall@1':>9}{'recall@3':>9}{'MRR':>6}{'ms':>6}")
    for key, r in results.items():
        mode, source = key.split("|")
        print(
            f"{mode:<15}{source:<11}{r['recall@1']:>9.2f}{r['recall@3']:>9.2f}"
            f"{r['mrr']:>6.2f}{r['ms_per_query']:>6}"
        )
    print(f"\n{len(cases)} queries against {len(load_runbooks())} runbooks")


if __name__ == "__main__":
    main()

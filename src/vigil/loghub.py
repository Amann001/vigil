"""Benchmark log template mining on LogHub's 2k-line samples of 16 real systems.

One fixed parser setting is used for every system rather than tuning per dataset, which is what
Vigil faces in practice: logs it was not tuned for.

Run it with: uv run python -m vigil.loghub
"""

import argparse
import json
from pathlib import Path

import pandas as pd

from shop.config import DATA_DIR
from vigil.logparse import BASIC_MASKS, EXTENDED_MASKS, LogParser, grouping_accuracy

LOGHUB_DIR = DATA_DIR / "datasets" / "loghub"
RESULTS_DIR = DATA_DIR / "results"


MASK_SETS = {"basic": BASIC_MASKS, "extended": EXTENDED_MASKS}


def benchmark(loghub_dir: Path = LOGHUB_DIR) -> dict[str, dict]:
    """Grouping accuracy per system, for each mask set."""
    results: dict[str, dict] = {}
    for structured in sorted(loghub_dir.glob("*/*_2k.log_structured.csv")):
        system = structured.parent.name
        truth = pd.read_csv(structured, usecols=["Content", "EventId"])
        results[system] = {"lines": len(truth), "true_templates": int(truth["EventId"].nunique())}
        for mask_name, masks in MASK_SETS.items():
            parser = LogParser(masks=masks)
            predicted = parser.parse(truth["Content"].astype(str))
            accuracy = grouping_accuracy(list(truth["EventId"]), predicted)
            results[system][mask_name] = {
                "found_templates": len(parser.templates),
                "grouping_accuracy": round(accuracy, 3),
            }
    return results


def main() -> None:
    argparse.ArgumentParser(description="Benchmark log parsing on LogHub.").parse_args()
    results = benchmark()
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_DIR / "loghub.json").write_text(json.dumps(results, indent=2))

    print(f"{'system':<14}{'true templates':>15}" + "".join(f"{m:>12}" for m in MASK_SETS))
    for system, r in results.items():
        accuracies = "".join(f"{r[m]['grouping_accuracy']:>12.3f}" for m in MASK_SETS)
        print(f"{system:<14}{r['true_templates']:>15}{accuracies}")
    averages = "".join(
        f"{sum(r[m]['grouping_accuracy'] for r in results.values()) / len(results):>12.3f}"
        for m in MASK_SETS
    )
    print(f"{'average':<14}{'':>15}{averages}")


if __name__ == "__main__":
    main()

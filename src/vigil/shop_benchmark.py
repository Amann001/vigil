"""Score the detectors on Vigil's own incidents: a data-collection campaign on the demo shop.

The campaign starts with a healthy warm-up, then injects faults. Detectors learn only from the
warm-up and their alarm thresholds are calibrated on it, so no incident data is used for tuning.
Every setting in the grid is reported; one of them (HEADLINE) was fixed before looking at the
results and is the number quoted elsewhere.

Each detector is run on two feature sets: metrics only, and metrics plus log features (warnings,
errors, and kinds of log line never seen during the warm-up).

Run it with: uv run python -m vigil.shop_benchmark [dataset directory]
"""

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from shop.config import DATA_DIR
from vigil.detectors import IsolationForestDetector, RobustZScore, calibrate_threshold
from vigil.evaluation import Window, alarm_flags, evaluate
from vigil.logevents import log_features, templates_seen

DATASETS_DIR = DATA_DIR / "datasets" / "vigil"
RESULTS_DIR = DATA_DIR / "results"
# Rate and latency features are computed over a 30 s window, so the first samples of a run are
# partial. Skip them when training.
TRAIN_SKIP = pd.Timedelta("2min")
# The same 30 s window keeps metrics abnormal briefly after recovery; alarms in that tail are
# about the incident, not false.
GRACE = pd.Timedelta("60s")
QUANTILES = (0.99, 0.995, 0.999)
MIN_CONSECUTIVE = (1, 3)
HEADLINE = ("robust_zscore", "metrics", 0.995, 3)
DETECTORS = {
    "robust_zscore": RobustZScore,
    "zscore_per_feature": lambda: RobustZScore(per_feature_quantile=0.99),
    "isolation_forest": IsolationForestDetector,
}


@dataclass(frozen=True)
class Dataset:
    features: pd.DataFrame
    incidents: list[dict]
    events: pd.DataFrame
    train_start: pd.Timestamp
    train_end: pd.Timestamp


def latest_dataset(datasets_dir: Path = DATASETS_DIR) -> Path:
    runs = sorted(p for p in datasets_dir.iterdir() if (p / "meta.json").exists())
    if not runs:
        raise FileNotFoundError(f"No exported campaign in {datasets_dir}: run vigil.dataset")
    return runs[-1]


def load(directory: Path) -> Dataset:
    meta = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
    metrics = pd.read_csv(directory / "metrics.csv.gz", index_col="timestamp", parse_dates=True)
    events = pd.read_csv(directory / "logs.csv.gz")
    events["timestamp"] = pd.to_datetime(events["timestamp"], utc=True, format="ISO8601")
    return Dataset(
        features=metrics[meta["features"]],
        incidents=json.loads((directory / "incidents.json").read_text(encoding="utf-8")),
        events=events,
        train_start=pd.Timestamp(meta["started_at"]) + TRAIN_SKIP,
        train_end=pd.Timestamp(meta["warmup_ends_at"]),
    )


def feature_sets(data: Dataset) -> dict[str, pd.DataFrame]:
    known = templates_seen(data.events, before=data.train_end)
    logs = log_features(data.events, data.features.index, known)
    return {"metrics": data.features, "metrics+logs": data.features.join(logs)}


def first_alarm_delay(flags: pd.Series, window: Window) -> float | None:
    alarmed = flags[(flags.index >= window.start) & (flags.index <= window.end + GRACE) & flags]
    return (alarmed.index[0] - window.start).total_seconds() if len(alarmed) else None


def benchmark(data: Dataset) -> dict:
    windows = [Window(pd.Timestamp(i["start"]), pd.Timestamp(i["end"])) for i in data.incidents]
    results: dict = {}
    for set_name, features in feature_sets(data).items():
        training = (features.index >= data.train_start) & (features.index < data.train_end)
        for detector_name, detector_class in DETECTORS.items():
            detector = detector_class().fit(features[training])
            scores = detector.score(features)
            for quantile in QUANTILES:
                threshold = calibrate_threshold(scores[training], quantile)
                for min_consecutive in MIN_CONSECUTIVE:
                    flags = alarm_flags(scores, threshold, min_consecutive)
                    report = evaluate(flags, windows, GRACE, ignore_before=data.train_end)
                    key = f"{detector_name}|{set_name}|{quantile}|{min_consecutive}"
                    results[key] = {
                        **report.as_dict(),
                        "per_incident": [
                            {
                                "id": incident["id"],
                                "service": incident["service"],
                                "fault": incident["fault"],
                                "delay_seconds": first_alarm_delay(flags, window),
                            }
                            for incident, window in zip(data.incidents, windows, strict=True)
                        ],
                    }
    return results


def headline_key() -> str:
    return "|".join(str(part) for part in HEADLINE)


def main() -> None:
    parser = argparse.ArgumentParser(description="Score the detectors on a shop campaign.")
    parser.add_argument("dataset", nargs="?", type=Path, help="defaults to the latest export")
    args = parser.parse_args()
    directory = args.dataset or latest_dataset()
    results = benchmark(load(directory))
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    output = RESULTS_DIR / "shop.json"
    output.write_text(json.dumps({"dataset": directory.name, "results": results}, indent=2))

    print(f"{'detector':<20}{'features':<14}{'quantile':>9}{'in a row':>9}", end="")
    print(f"{'recall':>8}{'precision':>11}{'false/hour':>12}{'delay (s)':>11}")
    for key, r in results.items():
        detector, features, quantile, in_a_row = key.split("|")
        delay = r["median_delay_seconds"]
        marker = "  <- headline" if key == headline_key() else ""
        print(
            f"{detector:<20}{features:<14}{quantile:>9}{in_a_row:>9}{r['recall']:>8.2f}"
            f"{r['precision']:>11.2f}{r['false_alarms_per_hour']:>12.1f}"
            f"{'-' if delay is None else f'{delay:.0f}':>11}{marker}"
        )
    print(f"\nHeadline per incident ({headline_key()}):")
    for incident in results[headline_key()]["per_incident"]:
        delay = incident["delay_seconds"]
        found = "missed" if delay is None else f"after {delay:.0f} s"
        print(f"  {incident['id']:>2}. {incident['service']:<11}{incident['fault']:<9}{found}")
    print(f"\nSaved to {output}")


if __name__ == "__main__":
    main()

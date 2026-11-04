"""Benchmark the detectors on NAB, the Numenta Anomaly Benchmark.

NAB has 58 real and artificial time series with labelled anomaly windows. Following NAB's own
convention, the first 15% of each series is a probationary period: the detector learns from it
and alarms there are not scored.

The scores are incident-level (see vigil.evaluation), not NAB's official weighted score, so they
are comparable across Vigil's own experiments rather than with the NAB leaderboard.

Run it with: uv run python -m vigil.nab
"""

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from shop.config import DATA_DIR
from vigil.autoencoder import LstmAutoencoderDetector
from vigil.detectors import Detector, IsolationForestDetector, RobustZScore, calibrate_threshold
from vigil.evaluation import Window, alarm_flags, evaluate

NAB_DIR = DATA_DIR / "datasets" / "nab"
RESULTS_DIR = DATA_DIR / "results"
PROBATIONARY_SHARE = 0.15
ROLLING_POINTS = 12
QUANTILES = (0.99, 0.995, 0.999)
DETECTORS = {
    "robust_zscore": RobustZScore,
    "zscore_per_feature": lambda: RobustZScore(per_feature_quantile=0.99),
    "isolation_forest": IsolationForestDetector,
    "lstm_autoencoder": LstmAutoencoderDetector,
}


@dataclass(frozen=True)
class SeriesResult:
    series: str
    windows: int
    detected: int
    alarm_events: int
    false_alarm_events: int
    first_alarm_positions: tuple[float, ...]  # 0 = window start, 1 = window end
    scored_points: int
    window_points: int


def load_series(name: str, nab_dir: Path = NAB_DIR) -> pd.Series:
    frame = pd.read_csv(nab_dir / "data" / name, parse_dates=["timestamp"])
    return frame.set_index(frame["timestamp"].dt.tz_localize("UTC"))["value"]


def load_windows(nab_dir: Path = NAB_DIR) -> dict[str, list[Window]]:
    raw = json.loads((nab_dir / "labels" / "combined_windows.json").read_text(encoding="utf-8"))
    return {
        name: [Window(pd.Timestamp(s, tz="UTC"), pd.Timestamp(e, tz="UTC")) for s, e in windows]
        for name, windows in raw.items()
    }


def univariate_features(values: pd.Series) -> pd.DataFrame:
    """A single series becomes three signals: its level, its jumps, and its distance from the
    recent typical level (which catches both spikes and slow drifts)."""
    rolling_median = values.rolling(ROLLING_POINTS, min_periods=1).median()
    return pd.DataFrame(
        {
            "value": values,
            "change": values.diff().fillna(0.0),
            "deviation": values - rolling_median,
        }
    )


def run_series(
    name: str,
    values: pd.Series,
    windows: list[Window],
    detector: Detector,
    quantiles: tuple[float, ...] = QUANTILES,
) -> dict[float, SeriesResult]:
    """Train once on the probationary period, then evaluate each alarm threshold."""
    features = univariate_features(values)
    train_end = int(len(features) * PROBATIONARY_SHARE)
    detector.fit(features.iloc[:train_end])
    scores = detector.score(features)
    training_scores = scores.iloc[:train_end]

    scored_index = features.index[train_end:]
    inside = pd.Series(False, index=scored_index)
    for window in windows:
        inside |= (scored_index >= window.start) & (scored_index <= window.end)
    scored = [w for w in windows if w.end >= features.index[train_end]]

    results = {}
    for quantile in quantiles:
        flags = alarm_flags(scores, calibrate_threshold(training_scores, quantile))
        report = evaluate(flags, windows, ignore_before=features.index[train_end])
        positions = []
        for window in scored:
            alarmed = flags[(flags.index >= window.start) & (flags.index <= window.end) & flags]
            if len(alarmed):
                positions.append((alarmed.index[0] - window.start) / (window.end - window.start))
        results[quantile] = SeriesResult(
            name,
            report.incidents,
            report.detected,
            report.alarm_events,
            report.false_alarm_events,
            tuple(positions),
            len(scored_index),
            int(inside.sum()),
        )
    return results


def summarize(results: list[SeriesResult]) -> dict:
    windows = sum(r.windows for r in results)
    detected = sum(r.detected for r in results)
    events = sum(r.alarm_events for r in results)
    false = sum(r.false_alarm_events for r in results)
    recall = detected / windows if windows else float("nan")
    precision = (events - false) / events if events else float("nan")
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    positions = [p for r in results for p in r.first_alarm_positions]
    coverage = sum(r.window_points for r in results) / sum(r.scored_points for r in results)
    return {
        "series": len(results),
        "windows": windows,
        "detected": detected,
        "recall": round(recall, 3),
        "alarm_events": events,
        "false_alarm_events": false,
        "precision": round(precision, 3),
        # A detector alarming at random points would have roughly this precision.
        "random_alarm_precision": round(coverage, 3),
        "f1": round(f1, 3),
        "median_first_alarm_position": round(float(pd.Series(positions).median()), 3)
        if positions
        else None,
    }


def benchmark(nab_dir: Path = NAB_DIR) -> dict:
    windows = load_windows(nab_dir)
    series = {name: load_series(name, nab_dir) for name in windows}
    results: dict = {}
    for detector_name, detector_class in DETECTORS.items():
        per_quantile = [
            run_series(name, values, windows[name], detector_class())
            for name, values in series.items()
        ]
        for quantile in QUANTILES:
            per_series = [results_by_quantile[quantile] for results_by_quantile in per_quantile]
            results[f"{detector_name}@{quantile}"] = {
                "overall": summarize(per_series),
                "by_category": {
                    category: summarize([r for r in per_series if r.series.startswith(category)])
                    for category in sorted({r.series.split("/")[0] for r in per_series})
                },
            }
    return results


def main() -> None:
    argparse.ArgumentParser(description="Benchmark Vigil's detectors on NAB.").parse_args()
    results = benchmark()
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_DIR / "nab.json").write_text(json.dumps(results, indent=2))

    header = f"{'detector @ threshold':<28}{'recall':>8}{'precision':>11}{'F1':>7}"
    print(header + f"{'false alarms':>14}{'first alarm':>13}")
    for key, value in results.items():
        o = value["overall"]
        position = o["median_first_alarm_position"]
        print(
            f"{key:<28}{o['recall']:>8.2f}{o['precision']:>11.2f}{o['f1']:>7.2f}"
            f"{o['false_alarm_events']:>14}{'' if position is None else f'{position:.0%}':>13}"
        )
    print(
        f"\n{results[key]['overall']['windows']} anomaly windows across "
        f"{results[key]['overall']['series']} series. Saved to {RESULTS_DIR / 'nab.json'}"
    )


if __name__ == "__main__":
    main()

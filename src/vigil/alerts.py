"""Turn detector alarms into alerts that say what looked wrong.

An alert is what pages the on-call engineer: when it fired and the most unusual signals at that
moment, compared with their usual values. It uses the headline detector from the shop
benchmark (robust z-score, 0.995 quantile, 3 points in a row) and fires once per alarm event.
"""

from dataclasses import dataclass
from typing import Self

import pandas as pd

from vigil.detectors import RobustZScore, calibrate_threshold
from vigil.evaluation import alarm_events, alarm_flags

QUANTILE = 0.995
MIN_CONSECUTIVE = 3
TOP_SIGNALS = 6


@dataclass(frozen=True)
class Signal:
    feature: str
    value: float  # NaN when the series stopped reporting
    usual: float
    deviations: float


@dataclass(frozen=True)
class Alert:
    detected_at: pd.Timestamp
    signals: tuple[Signal, ...]

    def describe(self) -> str:
        lines = [f"Anomaly alert at {self.detected_at:%Y-%m-%d %H:%M:%S} UTC."]
        lines.append("Most unusual signals (value, usual value, typical deviations away):")
        for s in self.signals:
            value = "missing (stopped reporting)" if pd.isna(s.value) else f"{s.value:.4g}"
            lines.append(f"- {s.feature}: {value}, usual {s.usual:.4g}, {s.deviations:.0f}x")
        return "\n".join(lines)


class AlertDetector:
    def __init__(self, quantile: float = QUANTILE, min_consecutive: int = MIN_CONSECUTIVE) -> None:
        self.quantile = quantile
        self.min_consecutive = min_consecutive

    def fit(self, normal: pd.DataFrame) -> Self:
        self.detector = RobustZScore().fit(normal)
        self.threshold = calibrate_threshold(self.detector.score(normal), self.quantile)
        return self

    def alerts(self, features: pd.DataFrame) -> list[Alert]:
        """One alert per alarm event, at the moment the alarm fired."""
        flags = alarm_flags(self.detector.score(features), self.threshold, self.min_consecutive)
        return [self.explain(features.loc[event.start]) for event in alarm_events(flags)]

    def explain(self, row: pd.Series) -> Alert:
        detector = self.detector
        filled = row[detector.columns].astype(float).fillna(0.0)
        deviations = ((filled - detector.median).abs() / detector.scale).sort_values(
            ascending=False
        )
        signals = tuple(
            Signal(name, float(row[name]), float(detector.median[name]), float(deviations[name]))
            for name in deviations.index[:TOP_SIGNALS]
        )
        return Alert(pd.Timestamp(row.name), signals)

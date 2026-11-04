"""Anomaly detectors: learn what "normal" looks like, then score how unusual new data is.

Every detector is trained only on normal operation and exposes the same two methods:
`fit(normal_rows)` and `score(rows)`, where a higher score means more unusual. An alarm threshold
is then calibrated on the training scores, so no incident data is ever used to tune it.
"""

from typing import Protocol, Self

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

# Missing values mean a series stopped reporting, usually because its service is down. They are
# filled with 0, which is far from normal for rates, latency and memory, so it reads as unusual.
FILL_VALUE = 0.0


class Detector(Protocol):
    name: str

    def fit(self, normal: pd.DataFrame) -> Self: ...

    def score(self, rows: pd.DataFrame) -> pd.Series: ...


class RobustZScore:
    """Statistical baseline: how many "typical deviations" each feature is from its median.

    The score of a row is its most extreme feature. Median and MAD (median absolute deviation)
    are used instead of mean and standard deviation so outliers in training don't distort them.
    """

    name = "robust_zscore"

    def __init__(self, min_scale: float = 1e-3) -> None:
        # Floor on each feature's spread, so a feature that never moved in training (an error
        # ratio that was always 0) still gets a finite, very large score when it does move.
        self.min_scale = min_scale

    def fit(self, normal: pd.DataFrame) -> Self:
        values = normal.fillna(FILL_VALUE)
        self.columns = list(values.columns)
        self.median = values.median()
        mad = (values - self.median).abs().median()
        self.scale = (1.4826 * mad).clip(lower=self.min_scale)
        return self

    def score(self, rows: pd.DataFrame) -> pd.Series:
        values = rows[self.columns].fillna(FILL_VALUE)
        z = (values - self.median).abs() / self.scale
        return z.max(axis=1).rename(self.name)


class IsolationForestDetector:
    """ML baseline: an ensemble of random trees that isolates points by random splits.

    Unusual points are isolated in fewer splits than normal ones, so the average path length
    becomes the anomaly score. Unlike the z-score it can flag unusual *combinations* of
    features, such as normal traffic with abnormal latency on one service.
    """

    name = "isolation_forest"

    def __init__(self, n_estimators: int = 200, seed: int = 0) -> None:
        self.model = IsolationForest(n_estimators=n_estimators, random_state=seed)

    def fit(self, normal: pd.DataFrame) -> Self:
        values = normal.fillna(FILL_VALUE)
        self.columns = list(values.columns)
        # Scale each feature by its typical spread so no feature dominates the random splits.
        self.median = values.median()
        spread = values.quantile(0.75) - values.quantile(0.25)
        self.scale = spread.where(spread > 0, values.std()).replace(0, 1).fillna(1)
        self.model.fit(self._prepare(values))
        return self

    def score(self, rows: pd.DataFrame) -> pd.Series:
        values = rows[self.columns].fillna(FILL_VALUE)
        # score_samples is higher for normal points; negate so higher means more unusual.
        scores = -self.model.score_samples(self._prepare(values))
        return pd.Series(scores, index=rows.index, name=self.name)

    def _prepare(self, values: pd.DataFrame) -> np.ndarray:
        return ((values - self.median) / self.scale).to_numpy()


def calibrate_threshold(training_scores: pd.Series, quantile: float) -> float:
    """Alarm threshold: the score that only `1 - quantile` of normal training rows exceed."""
    return float(np.quantile(training_scores.to_numpy(), quantile))

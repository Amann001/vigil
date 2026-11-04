import numpy as np
import pandas as pd
import pytest

from vigil.detectors import IsolationForestDetector, RobustZScore, calibrate_threshold

INDEX = pd.date_range("2026-01-01", periods=500, freq="5s", tz="UTC")


def normal_data(seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    return pd.DataFrame(
        {
            "latency": rng.normal(0.1, 0.01, len(INDEX)),
            "rate": rng.normal(5.0, 0.5, len(INDEX)),
            "errors": np.zeros(len(INDEX)),  # never moves in normal operation
        },
        index=INDEX,
    )


@pytest.fixture(params=[RobustZScore, IsolationForestDetector])
def detector(request):
    return request.param().fit(normal_data())


def test_zscore_flags_values_beyond_the_training_range():
    detector = RobustZScore().fit(normal_data())
    test = normal_data(seed=1).iloc[:50].copy()
    test.iloc[40:, test.columns.get_loc("latency")] = 2.0  # 20x slower

    scores = detector.score(test)

    assert scores.iloc[40:].min() > scores.iloc[:40].max()


def test_zscore_flags_any_change_in_a_feature_that_never_moved():
    detector = RobustZScore().fit(normal_data())
    test = normal_data(seed=1).iloc[:50].copy()
    test.iloc[45:, test.columns.get_loc("errors")] = 0.2

    scores = detector.score(test)

    assert scores.iloc[45:].min() > scores.iloc[:45].max()


def test_missing_values_read_as_unusual(detector):
    test = normal_data(seed=1).iloc[:50].copy()
    test.iloc[45:] = np.nan  # the service stopped reporting

    scores = detector.score(test)

    assert scores.iloc[45:].min() > scores.iloc[:45].max()


def one_row(**changes: float) -> pd.DataFrame:
    row = normal_data(seed=1).iloc[:1].copy()
    for column, value in changes.items():
        row[column] = value
    return row


def test_isolation_forest_is_blind_to_features_that_never_moved():
    """Documented limitation: no tree can split on a constant feature."""
    detector = IsolationForestDetector().fit(normal_data())

    normal = detector.score(one_row()).iloc[0]
    with_errors = detector.score(one_row(errors=0.2)).iloc[0]

    assert with_errors == pytest.approx(normal)


def test_isolation_forest_saturates_beyond_the_training_range():
    """Documented limitation: trees only split within the range seen in training, so 20x and
    200x the normal latency score the same as the slowest normal point."""
    train = normal_data()
    detector = IsolationForestDetector().fit(train)

    at_max = detector.score(one_row(latency=train["latency"].max())).iloc[0]
    far_beyond = detector.score(one_row(latency=20.0)).iloc[0]

    assert far_beyond == pytest.approx(at_max)


def test_scores_keep_the_index(detector):
    test = normal_data(seed=2).iloc[:10]

    assert detector.score(test).index.equals(test.index)


def test_isolation_forest_is_reproducible():
    a = IsolationForestDetector(seed=3).fit(normal_data()).score(normal_data(seed=1))
    b = IsolationForestDetector(seed=3).fit(normal_data()).score(normal_data(seed=1))

    pd.testing.assert_series_equal(a, b)


def test_threshold_lets_through_the_requested_share_of_normal_rows():
    scores = pd.Series(np.arange(1000, dtype=float))

    threshold = calibrate_threshold(scores, 0.99)

    assert (scores > threshold).mean() == pytest.approx(0.01, abs=0.002)

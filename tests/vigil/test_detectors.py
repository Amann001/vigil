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


def test_zscore_mostly_constant_feature_does_not_drown_real_anomalies():
    """Regression: requests in flight are 0 most of the time and occasionally 1, so their MAD is
    0. With the spread floored at min_scale, one in-flight request scored 1000 and set the alarm
    threshold, hiding real incidents in the shop data."""
    train = normal_data()
    train["in_flight"] = np.where(np.arange(len(INDEX)) % 10 == 0, 1.0, 0.0)
    detector = RobustZScore().fit(train)

    busy = detector.score(one_row(in_flight=1.0)).iloc[0]
    slow = detector.score(one_row(in_flight=0.0, latency=2.0)).iloc[0]

    assert busy < 10
    assert slow > 10 * busy


def noisy_and_quiet_training() -> pd.DataFrame:
    """A noisy feature with occasional big spikes next to a quiet one (memory) that barely moves."""
    train = normal_data()
    spikes = np.arange(len(INDEX)) % 50 == 0
    train["latency"] = np.where(spikes, 1.0, train["latency"])  # 90 deviations, 2% of the time
    return train


def test_plain_zscore_lets_the_noisiest_feature_set_the_bar():
    detector = RobustZScore().fit(noisy_and_quiet_training())
    threshold = calibrate_threshold(detector.score(noisy_and_quiet_training()), 0.99)

    leaking = detector.score(one_row(rate=10.0)).iloc[0]  # rate: 10 deviations above normal

    assert leaking < threshold


def test_per_feature_zscore_judges_each_feature_by_its_own_noise():
    train = noisy_and_quiet_training()
    detector = RobustZScore(per_feature_quantile=0.99).fit(train)
    threshold = calibrate_threshold(detector.score(train), 0.99)

    leaking = detector.score(one_row(rate=10.0)).iloc[0]

    assert leaking > threshold
    assert detector.name == "zscore_per_feature"


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

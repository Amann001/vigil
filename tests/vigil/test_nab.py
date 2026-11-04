import json

import numpy as np
import pandas as pd
import pytest

from vigil.detectors import RobustZScore
from vigil.nab import load_series, load_windows, run_series, summarize, univariate_features

SERIES = "realTest/spike.csv"


@pytest.fixture
def nab_dir(tmp_path):
    """A one-series NAB-style dataset: noise with one spike inside a labelled window."""
    rng = np.random.default_rng(0)
    timestamps = pd.date_range("2024-01-01", periods=1000, freq="5min")
    values = rng.normal(10, 0.5, len(timestamps))
    values[700:705] = 40
    (tmp_path / "data" / "realTest").mkdir(parents=True)
    pd.DataFrame({"timestamp": timestamps.strftime("%Y-%m-%d %H:%M:%S"), "value": values}).to_csv(
        tmp_path / "data" / SERIES, index=False
    )
    window = [str(timestamps[680]), str(timestamps[720])]
    (tmp_path / "labels").mkdir()
    (tmp_path / "labels" / "combined_windows.json").write_text(json.dumps({SERIES: [window]}))
    return tmp_path


def test_loads_series_and_windows_in_utc(nab_dir):
    values = load_series(SERIES, nab_dir)
    windows = load_windows(nab_dir)[SERIES]

    assert len(values) == 1000
    assert str(values.index.tz) == "UTC"
    assert windows[0].start == values.index[680]


def test_univariate_features_capture_level_jump_and_drift():
    values = pd.Series([1.0, 1.0, 1.0, 9.0])

    features = univariate_features(values)

    assert list(features.columns) == ["value", "change", "deviation"]
    assert features["change"].iloc[-1] == 8.0
    assert features["deviation"].iloc[-1] > 0


def test_spike_inside_the_window_is_detected(nab_dir):
    values = load_series(SERIES, nab_dir)
    windows = load_windows(nab_dir)[SERIES]

    result = run_series(SERIES, values, windows, RobustZScore(), quantile=0.999)

    assert result.detected == 1
    assert result.window_points == 41
    assert result.scored_points == 850  # the first 15% is the probationary period
    assert 0 <= result.first_alarm_positions[0] <= 1


def test_summary_includes_the_random_alarm_reference(nab_dir):
    values = load_series(SERIES, nab_dir)
    windows = load_windows(nab_dir)[SERIES]
    result = run_series(SERIES, values, windows, RobustZScore(), quantile=0.999)

    summary = summarize([result])

    assert summary["recall"] == 1.0
    assert summary["random_alarm_precision"] == pytest.approx(41 / 850, abs=0.001)

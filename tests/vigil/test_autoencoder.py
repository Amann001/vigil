import numpy as np
import onnxruntime
import pandas as pd
import pytest

from vigil.autoencoder import (
    SEQUENCE_LENGTH,
    LstmAutoencoderDetector,
    build_model,
    to_onnx,
    windows,
)

torch = pytest.importorskip("torch", reason="training needs the `train` dependency group")

INDEX = pd.date_range("2026-01-01", periods=600, freq="5s", tz="UTC")


def normal_data(seed: int = 0) -> pd.DataFrame:
    """A daily-style cycle in traffic, with latency following it, plus noise."""
    rng = np.random.default_rng(seed)
    cycle = np.sin(np.arange(len(INDEX)) * 2 * np.pi / 120)
    return pd.DataFrame(
        {
            "rate": 5 + cycle + rng.normal(0, 0.1, len(INDEX)),
            "latency": 0.1 + 0.02 * cycle + rng.normal(0, 0.002, len(INDEX)),
        },
        index=INDEX,
    )


@pytest.fixture(scope="module")
def detector():
    return LstmAutoencoderDetector().fit(normal_data())


def test_windows_are_consecutive_rows():
    values = np.arange(20, dtype=np.float32).reshape(10, 2)

    result = windows(values, length=4)

    assert result.shape == (7, 4, 2)
    np.testing.assert_array_equal(result[0], values[:4])
    np.testing.assert_array_equal(result[-1], values[-4:])


def test_too_few_rows_give_no_windows():
    assert windows(np.zeros((3, 2)), length=4).shape == (0, 4, 2)


def test_onnx_export_matches_pytorch():
    model = build_model(features=2)
    batch = np.random.default_rng(0).normal(size=(5, SEQUENCE_LENGTH, 2)).astype(np.float32)

    session = onnxruntime.InferenceSession(to_onnx(model, batch[:1]))
    from_onnx = session.run(None, {"window": batch})[0]
    with torch.no_grad():
        from_torch = model(torch.from_numpy(batch)).numpy()

    np.testing.assert_allclose(from_onnx, from_torch, rtol=1e-4, atol=1e-5)


def test_learns_normal_and_flags_an_anomaly(detector):
    test = normal_data(seed=1)
    test.iloc[300:320, test.columns.get_loc("latency")] = 0.5  # 5x slower

    scores = detector.score(test)

    assert scores.iloc[300:320].max() > 5 * scores.iloc[SEQUENCE_LENGTH:300].quantile(0.99)


def test_held_out_loss_drives_early_stopping(detector):
    history = detector.training["history"]
    best = detector.training["best_epoch"]

    assert history[best]["validation"] == min(h["validation"] for h in history)


def test_scores_are_causal(detector):
    """A row's score uses only that row and the ones before it."""
    test = normal_data(seed=1)
    changed = test.copy()
    changed.iloc[400:] = 99.0

    before, after = detector.score(test), detector.score(changed)

    pd.testing.assert_series_equal(before.iloc[:400], after.iloc[:400])
    assert (before.iloc[: SEQUENCE_LENGTH - 1] == 0).all()


def test_saved_model_scores_identically_without_retraining(detector, tmp_path):
    detector.save(tmp_path)
    loaded = LstmAutoencoderDetector.load(tmp_path)
    test = normal_data(seed=2)

    pd.testing.assert_series_equal(loaded.score(test), detector.score(test))

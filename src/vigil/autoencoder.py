"""LSTM autoencoder: a neural network that learns what a healthy minute of the shop looks like.

The network reads a window of the last 12 samples (60 s), squeezes it into a small summary (the
encoder), and tries to rebuild the whole window from that summary alone (the decoder). Trained
only on healthy data, it learns to rebuild healthy patterns well, including how features move
together over time. During an incident the window looks like nothing it was trained on, so the
rebuild is poor: the reconstruction error is the anomaly score.

Training uses PyTorch (the optional `train` dependency group, CPU only). The trained network is
exported to ONNX and scored with ONNX Runtime, so running Vigil does not need PyTorch.

Train on the latest campaign's warm-up and save the model with:
uv run python -m vigil.autoencoder
"""

import argparse
import io
import json
from pathlib import Path
from typing import Self

import numpy as np
import onnxruntime
import pandas as pd

from shop.config import DATA_DIR
from vigil.detectors import FILL_VALUE, RobustZScore

MODEL_DIR = DATA_DIR / "models" / "lstm_autoencoder"

SEQUENCE_LENGTH = 12  # 60 s of 5 s samples
HIDDEN_SIZE = 32
BATCH_SIZE = 64
LEARNING_RATE = 1e-3
MAX_EPOCHS = 200
# Stop when the held-out loss has not improved for this many epochs, and keep the best weights.
PATIENCE = 15
# The last part of the training period (in time order) is held out to decide when to stop.
VALIDATION_SHARE = 0.2
# Inputs are robust z-scores. Clipping keeps one extreme value from blowing up training; a
# clipped value is still far outside anything healthy, so it still scores high.
CLIP = 50.0


def windows(values: np.ndarray, length: int = SEQUENCE_LENGTH) -> np.ndarray:
    """Every run of `length` consecutive rows: shape (rows - length + 1, length, features)."""
    if len(values) < length:
        return np.empty((0, length, values.shape[1]), dtype=np.float32)
    view = np.lib.stride_tricks.sliding_window_view(values, length, axis=0)
    return np.ascontiguousarray(view.transpose(0, 2, 1), dtype=np.float32)


def build_model(features: int, seed: int = 0):
    """The network: an encoder LSTM, then a decoder LSTM fed the summary at every step."""
    import torch
    from torch import nn

    class LstmAutoencoder(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.encoder = nn.LSTM(features, HIDDEN_SIZE, batch_first=True)
            self.decoder = nn.LSTM(HIDDEN_SIZE, HIDDEN_SIZE, batch_first=True)
            self.output = nn.Linear(HIDDEN_SIZE, features)

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            _, (summary, _) = self.encoder(x)  # the final hidden state summarises the window
            repeated = summary[-1].unsqueeze(1).repeat(1, x.shape[1], 1)
            decoded, _ = self.decoder(repeated)
            return self.output(decoded)

    torch.manual_seed(seed)
    return LstmAutoencoder()


def to_onnx(model, example: np.ndarray) -> bytes:
    """Export a trained network to ONNX, accepting any number of windows at once.

    This uses PyTorch's older TorchScript exporter, which handles LSTMs without extra packages.
    It warns that a variable batch size can break LSTM exports; the tests check that ONNX and
    PyTorch outputs agree for a batch larger than the one exported with.
    """
    import torch

    buffer = io.BytesIO()
    torch.onnx.export(
        model.eval(),
        (torch.from_numpy(example),),
        buffer,
        input_names=["window"],
        output_names=["reconstruction"],
        dynamic_axes={"window": {0: "batch"}, "reconstruction": {0: "batch"}},
        dynamo=False,
    )
    return buffer.getvalue()


def train(sequences: np.ndarray, seed: int = 0) -> tuple[bytes, dict]:
    """Train on healthy windows and return the network as ONNX bytes, plus training history."""
    import torch
    from torch import nn

    model = build_model(sequences.shape[2], seed)
    generator = torch.Generator().manual_seed(seed)
    split = int(len(sequences) * (1 - VALIDATION_SHARE))
    fit_part = torch.from_numpy(sequences[:split])
    held_out = torch.from_numpy(sequences[split:])

    optimizer = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)
    loss_fn = nn.MSELoss()
    best_loss, best_state, best_epoch, history = float("inf"), None, 0, []
    for epoch in range(MAX_EPOCHS):
        model.train()
        order = torch.randperm(len(fit_part), generator=generator)
        for start in range(0, len(order), BATCH_SIZE):
            batch = fit_part[order[start : start + BATCH_SIZE]]
            optimizer.zero_grad()
            loss_fn(model(batch), batch).backward()
            optimizer.step()
        model.eval()
        with torch.no_grad():
            train_loss = loss_fn(model(fit_part), fit_part).item()
            validation_loss = loss_fn(model(held_out), held_out).item()
        history.append({"epoch": epoch, "train": train_loss, "validation": validation_loss})
        if validation_loss < best_loss:
            best_loss, best_epoch = validation_loss, epoch
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
        elif epoch - best_epoch >= PATIENCE:
            break
    model.load_state_dict(best_state)
    return to_onnx(model, sequences[:1]), {"best_epoch": best_epoch, "history": history}


class LstmAutoencoderDetector:
    """Anomaly score of a row: how badly the network rebuilds the 60 s window ending at it.

    Inputs are scaled like the z-score detector (median and MAD), so a feature that never moved
    in training still stands out when it does. Only past rows are used, so scoring is causal: a
    row's score never depends on what happens after it.
    """

    name = "lstm_autoencoder"

    def __init__(self, seed: int = 0) -> None:
        self.seed = seed

    def fit(self, normal: pd.DataFrame) -> Self:
        self.scaling = RobustZScore().fit(normal)
        self.columns = self.scaling.columns
        self.model, self.training = train(windows(self._prepare(normal)), self.seed)
        self._start_session()
        return self

    def save(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "model.onnx").write_bytes(self.model)
        scaling = {
            "columns": self.columns,
            "median": self.scaling.median.tolist(),
            "scale": self.scaling.scale.tolist(),
        }
        (directory / "scaling.json").write_text(json.dumps(scaling, indent=2))

    @classmethod
    def load(cls, directory: Path) -> Self:
        """A trained detector, ready to score, without needing PyTorch."""
        detector = cls()
        scaling = json.loads((directory / "scaling.json").read_text(encoding="utf-8"))
        detector.columns = scaling["columns"]
        detector.scaling = RobustZScore()
        detector.scaling.columns = detector.columns
        detector.scaling.median = pd.Series(scaling["median"], index=detector.columns)
        detector.scaling.scale = pd.Series(scaling["scale"], index=detector.columns)
        detector.model = (directory / "model.onnx").read_bytes()
        detector._start_session()
        return detector

    def _start_session(self) -> None:
        self.session = onnxruntime.InferenceSession(self.model, providers=["CPUExecutionProvider"])

    def score(self, rows: pd.DataFrame) -> pd.Series:
        sequences = windows(self._prepare(rows[self.columns]))
        scores = np.zeros(len(rows))  # the first rows have no full window and cannot alarm
        if len(sequences):
            rebuilt = self.session.run(None, {"window": sequences})[0]
            scores[SEQUENCE_LENGTH - 1 :] = ((rebuilt - sequences) ** 2).mean(axis=(1, 2))
        return pd.Series(scores, index=rows.index, name=self.name)

    def _prepare(self, values: pd.DataFrame) -> np.ndarray:
        filled = values.fillna(FILL_VALUE)
        z = (filled - self.scaling.median) / self.scaling.scale
        return z.clip(-CLIP, CLIP).to_numpy(dtype=np.float32)


def main() -> None:
    from vigil.shop_benchmark import latest_dataset, load

    parser = argparse.ArgumentParser(description="Train the LSTM autoencoder on a campaign.")
    parser.add_argument("dataset", nargs="?", type=Path, help="defaults to the latest export")
    parser.add_argument("--output", type=Path, default=MODEL_DIR)
    args = parser.parse_args()
    data = load(args.dataset or latest_dataset())
    training = (data.features.index >= data.train_start) & (data.features.index < data.train_end)
    detector = LstmAutoencoderDetector().fit(data.features[training])
    detector.save(args.output)
    best = detector.training["history"][detector.training["best_epoch"]]
    print(
        f"Trained on {training.sum()} healthy rows; best epoch {detector.training['best_epoch']} "
        f"(train loss {best['train']:.3f}, held-out loss {best['validation']:.3f})"
    )
    print(f"Saved to {args.output} ({len(detector.model) / 1000:.0f} KB)")


if __name__ == "__main__":
    main()

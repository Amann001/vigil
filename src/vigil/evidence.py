"""What Vigil's agents can see: the shop's metrics and logs up to one moment in time.

Two sources share one interface:
- LiveEvidence reads Prometheus and the live log files, for real incidents.
- ReplayEvidence reads an exported campaign, to re-run investigations on recorded incidents.

Both refuse to return anything after `as_of`, so a replayed investigation cannot see the future.
Neither reads ground truth: not the fault-injection ledger, not the incident labels.
"""

import gzip
import json
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Protocol

import httpx
import pandas as pd

from shop.config import DATA_DIR
from vigil.telemetry import fetch_features

LOG_DIR = DATA_DIR / "logs"
LOG_COLUMNS = ["timestamp", "service", "level", "logger", "message", "fields"]
# Keys every log line has, or that only repeat the message with colour codes.
_BASE_KEYS = {"timestamp", "service", "level", "logger", "message", "color_message"}
_TIMESTAMP_PREFIX = '{"timestamp": "'


class Evidence(Protocol):
    as_of: pd.Timestamp

    def metrics(self, minutes: float) -> pd.DataFrame:
        """The feature table (one row per 5 s) for the `minutes` before `as_of`."""
        ...

    def logs(self, minutes: float) -> pd.DataFrame:
        """Every log line in the `minutes` before `as_of`, oldest first."""
        ...


def parse_log_lines(lines: Iterable[str], start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    """JSON log lines between `start` and `end` as a table; extra keys go into `fields`."""
    # The shop writes the timestamp first, as a fixed-format UTC string, so comparing that text
    # skips most lines without parsing their JSON. Any other line is parsed in full.
    low, high = _iso(start), _iso(end)
    rows = []
    for line in lines:
        if line.startswith(_TIMESTAMP_PREFIX):
            stamp = line[len(_TIMESTAMP_PREFIX) : len(_TIMESTAMP_PREFIX) + len(low)]
            if not (low <= stamp <= high):
                continue
            entry = json.loads(line)
        else:
            entry = json.loads(line)
            if not (start <= pd.Timestamp(entry["timestamp"]) <= end):
                continue
        rows.append(
            {
                **{key: entry.get(key) for key in LOG_COLUMNS[:-1]},
                "fields": {k: v for k, v in entry.items() if k not in _BASE_KEYS},
            }
        )
    if not rows:
        return pd.DataFrame(columns=LOG_COLUMNS)
    table = pd.DataFrame(rows)
    table["timestamp"] = pd.to_datetime(table["timestamp"], utc=True, format="ISO8601")
    return table.sort_values("timestamp", kind="stable").reset_index(drop=True)


def _iso(timestamp: pd.Timestamp) -> str:
    return timestamp.tz_convert("UTC").isoformat(timespec="milliseconds")


def _read_lines(paths: Iterable[Path]) -> Iterator[str]:
    for path in paths:
        opener = gzip.open if path.suffix == ".gz" else open
        with opener(path, "rt", encoding="utf-8") as file:
            yield from (line for line in file if line.strip())


class LiveEvidence:
    """The running shop. `as_of` is fixed when the investigation starts."""

    def __init__(
        self, client: httpx.Client, log_dir: Path = LOG_DIR, as_of: pd.Timestamp | None = None
    ) -> None:
        self.client = client
        self.log_dir = log_dir
        self.as_of = as_of or pd.Timestamp.now(tz="UTC").floor("s")

    def metrics(self, minutes: float) -> pd.DataFrame:
        start = self.as_of - pd.Timedelta(minutes=minutes)
        return fetch_features(start.to_pydatetime(), self.as_of.to_pydatetime(), self.client)

    def logs(self, minutes: float) -> pd.DataFrame:
        start = self.as_of - pd.Timedelta(minutes=minutes)
        return parse_log_lines(_read_lines(sorted(self.log_dir.glob("*.log*"))), start, self.as_of)


class ReplayEvidence:
    """A recorded campaign, seen as it was at `as_of`."""

    def __init__(self, dataset_dir: Path, as_of: pd.Timestamp) -> None:
        meta = json.loads((dataset_dir / "meta.json").read_text(encoding="utf-8"))
        table = pd.read_csv(dataset_dir / "metrics.csv.gz", index_col="timestamp", parse_dates=True)
        self._metrics = table[meta["features"]]  # the feature columns only, never the labels
        self._log_lines = list(_read_lines(sorted((dataset_dir / "raw_logs").glob("*.jsonl.gz"))))
        self.as_of = as_of

    def metrics(self, minutes: float) -> pd.DataFrame:
        start = self.as_of - pd.Timedelta(minutes=minutes)
        index = self._metrics.index
        return self._metrics[(index > start) & (index <= self.as_of)]

    def logs(self, minutes: float) -> pd.DataFrame:
        start = self.as_of - pd.Timedelta(minutes=minutes)
        return parse_log_lines(self._log_lines, start, self.as_of)

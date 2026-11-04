import json

import numpy as np
import pandas as pd
import pytest

from vigil.shop_benchmark import (
    DETECTORS,
    GRACE,
    HEADLINE,
    MIN_CONSECUTIVE,
    QUANTILES,
    TRAIN_SKIP,
    benchmark,
    feature_sets,
    headline_key,
    latest_dataset,
    load,
)

START = pd.Timestamp("2026-11-04T12:00:00Z")
WARMUP = pd.Timedelta("60min")
INCIDENT_START = START + WARMUP + pd.Timedelta("20min")
INCIDENT_END = INCIDENT_START + pd.Timedelta("3min")
END = START + WARMUP + pd.Timedelta("60min")


def write_campaign(directory):
    """A healthy shop with one obvious incident: orders latency jumps 20x for three minutes."""
    index = pd.date_range(START, END, freq="5s", name="timestamp")
    rng = np.random.default_rng(0)
    metrics = pd.DataFrame(
        {
            "orders.latency_p95": rng.normal(0.1, 0.01, len(index)),
            "orders.request_rate": rng.normal(5.0, 0.5, len(index)),
        },
        index=index,
    )
    inside = (index >= INCIDENT_START) & (index <= INCIDENT_END)
    metrics.loc[inside, "orders.latency_p95"] = 2.0
    metrics.to_csv(directory / "metrics.csv.gz")

    logs = [
        {
            "timestamp": START + pd.Timedelta(seconds=s),
            "service": "orders",
            "level": "INFO",
            "template": "INFO shop.orders: order confirmed",
        }
        for s in range(0, int((END - START).total_seconds()), 30)
    ]
    logs.append(
        {
            "timestamp": INCIDENT_START + pd.Timedelta("2s"),
            "service": "orders",
            "level": "ERROR",
            "template": "ERROR shop.orders: something new",
        }
    )
    pd.DataFrame(logs).to_csv(directory / "logs.csv.gz", index=False)

    incident = {
        "id": 1,
        "service": "orders",
        "fault": "latency",
        "settings": {},
        "start": INCIDENT_START.isoformat(),
        "end": INCIDENT_END.isoformat(),
    }
    (directory / "incidents.json").write_text(json.dumps([incident]))
    meta = {
        "started_at": START.isoformat(),
        "warmup_ends_at": (START + WARMUP).isoformat(),
        "features": list(metrics.columns),
    }
    (directory / "meta.json").write_text(json.dumps(meta))
    return directory


@pytest.fixture
def results(tmp_path):
    return benchmark(load(write_campaign(tmp_path)))


def test_trains_only_on_the_warmup_after_the_skip(tmp_path):
    data = load(write_campaign(tmp_path))

    assert data.train_start == START + TRAIN_SKIP
    assert data.train_end == START + WARMUP


def test_every_setting_in_the_grid_is_reported(tmp_path):
    data = load(write_campaign(tmp_path))

    results = benchmark(data)

    sets = len(feature_sets(data))
    assert len(results) == len(DETECTORS) * sets * len(QUANTILES) * len(MIN_CONSECUTIVE)
    assert headline_key() in results
    assert headline_key().split("|") == [str(part) for part in HEADLINE]


def test_headline_detects_an_obvious_incident_without_false_alarms(results):
    headline = results[headline_key()]

    assert headline["recall"] == 1.0
    assert headline["false_alarm_events"] == 0
    (incident,) = headline["per_incident"]
    assert 0 <= incident["delay_seconds"] <= GRACE.total_seconds()


def test_log_features_count_lines_never_seen_in_the_warmup(tmp_path):
    data = load(write_campaign(tmp_path))

    with_logs = feature_sets(data)["metrics+logs"]

    assert with_logs["orders.log_new_templates"].sum() == 1
    assert with_logs.loc[with_logs.index < data.train_end, "orders.log_new_templates"].sum() == 0


def test_latest_dataset_picks_the_newest_export(tmp_path):
    for name in ("20261104T120000Z", "20261105T120000Z"):
        (tmp_path / name).mkdir()
        (tmp_path / name / "meta.json").write_text("{}")

    assert latest_dataset(tmp_path).name == "20261105T120000Z"


def test_missing_export_explains_what_to_run(tmp_path):
    with pytest.raises(FileNotFoundError, match="vigil.dataset"):
        latest_dataset(tmp_path)

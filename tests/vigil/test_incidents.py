import pandas as pd

from vigil.incidents import incident_windows, label, load_ledger

CAMPAIGN_END = pd.Timestamp("2026-11-04T13:00:00Z")

LEDGER = [
    {
        "timestamp": "2026-11-04T12:00:00Z",
        "action": "inject",
        "service": "payments",
        "fault": {"fault": "latency", "latency_seconds": 1.5, "duration_seconds": 60.0},
    },
    {
        "timestamp": "2026-11-04T12:10:00Z",
        "action": "inject",
        "service": "orders",
        "fault": {"fault": "crash", "duration_seconds": None},
    },
    {
        "timestamp": "2026-11-04T12:13:00Z",
        "action": "restart",
        "service": "orders",
        "fault": None,
    },
    {
        "timestamp": "2026-11-04T12:30:00Z",
        "action": "inject",
        "service": "inventory",
        "fault": {
            "fault": "leak",
            "leak_mb_per_second": 10,
            "leak_limit_mb": 400,
            "duration_seconds": None,
        },
    },
]


def test_timed_fault_ends_after_its_duration():
    latency = incident_windows(LEDGER, CAMPAIGN_END)[0]

    assert (latency.service, latency.fault) == ("payments", "latency")
    assert latency.end - latency.start == pd.Timedelta(seconds=60)
    assert latency.settings == {"latency_seconds": 1.5}


def test_untimed_fault_ends_at_its_recovery():
    crash = incident_windows(LEDGER, CAMPAIGN_END)[1]

    assert crash.end == pd.Timestamp("2026-11-04T12:13:00Z")


def test_unrecovered_fault_runs_to_campaign_end():
    leak = incident_windows(LEDGER, CAMPAIGN_END)[2]

    assert leak.end == CAMPAIGN_END
    assert leak.settings == {"leak_mb_per_second": 10, "leak_limit_mb": 400}


def test_recovery_of_another_service_does_not_end_an_incident():
    ledger = [
        LEDGER[1],
        {"timestamp": "2026-11-04T12:11:00Z", "action": "restart", "service": "payments"},
        LEDGER[2],
    ]

    crash = incident_windows(ledger, CAMPAIGN_END)[0]

    assert crash.end == pd.Timestamp("2026-11-04T12:13:00Z")


def test_missing_ledger_means_no_incidents(tmp_path):
    assert load_ledger(tmp_path / "ledger.jsonl") == []
    assert incident_windows([], CAMPAIGN_END) == []


def test_labels_mark_rows_inside_each_window():
    incidents = incident_windows(LEDGER, CAMPAIGN_END)
    index = pd.date_range("2026-11-04T11:59:00Z", "2026-11-04T12:15:00Z", freq="5s")

    labels = label(index, incidents)

    at = labels.loc
    assert not at[pd.Timestamp("2026-11-04T11:59:55Z"), "anomaly"]
    assert at[pd.Timestamp("2026-11-04T12:00:00Z"), "incident_fault"] == "latency"
    assert at[pd.Timestamp("2026-11-04T12:00:55Z"), "incident_service"] == "payments"
    assert not at[pd.Timestamp("2026-11-04T12:01:00Z"), "anomaly"]  # end is exclusive
    assert at[pd.Timestamp("2026-11-04T12:12:00Z"), "incident_id"] == 2
    assert labels["anomaly"].sum() == 12 + 36  # 60 s and 180 s at 5 s per row

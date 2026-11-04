import pandas as pd
import pytest

from vigil.evaluation import Window, alarm_events, alarm_flags, evaluate

INDEX = pd.date_range("2026-01-01 00:00", periods=720, freq="5s", tz="UTC")  # one hour


def at(minute: float) -> pd.Timestamp:
    return INDEX[0] + pd.Timedelta(minutes=minute)


def flags_between(*ranges: tuple[float, float]) -> pd.Series:
    flags = pd.Series(False, index=INDEX)
    for start, end in ranges:
        flags[(at(start) <= INDEX) & (at(end) >= INDEX)] = True
    return flags


def test_min_consecutive_suppresses_blips():
    scores = pd.Series([0, 9, 0, 9, 9, 9, 0], dtype=float)

    assert alarm_flags(scores, 5, min_consecutive=1).tolist() == [0, 1, 0, 1, 1, 1, 0]
    assert alarm_flags(scores, 5, min_consecutive=3).tolist() == [0, 0, 0, 0, 0, 1, 0]


def test_consecutive_alarms_merge_into_one_event():
    events = alarm_events(flags_between((10, 12), (30, 30.5)))

    assert events == [Window(at(10), at(12)), Window(at(30), at(30.5))]


def test_long_incident_counts_once_not_per_point():
    report = evaluate(flags_between((10, 14)), [Window(at(10), at(15))])

    assert report.detected == 1
    assert report.alarm_events == 1
    assert report.recall == 1.0
    assert report.precision == 1.0


def test_delay_is_measured_from_incident_start():
    report = evaluate(flags_between((11.5, 14)), [Window(at(10), at(15))])

    assert report.median_delay_seconds == pytest.approx(90)


def test_alarms_outside_incidents_are_false_alarms():
    report = evaluate(flags_between((10, 11), (40, 41)), [Window(at(10), at(15))])

    assert report.false_alarm_events == 1
    assert report.precision == 0.5
    assert report.false_alarms_per_hour == pytest.approx(1 / (55 / 60), rel=0.02)


def test_missed_incident_lowers_recall():
    report = evaluate(flags_between((10, 11)), [Window(at(10), at(15)), Window(at(30), at(35))])

    assert report.detected == 1
    assert report.recall == 0.5


def test_grace_period_forgives_the_recovery_tail():
    flags = flags_between((16, 16.5))  # just after the incident ended at minute 15
    incidents = [Window(at(10), at(15))]

    strict = evaluate(flags, incidents)
    lenient = evaluate(flags, incidents, grace=pd.Timedelta(minutes=2))

    assert strict.false_alarm_events == 1
    assert lenient.false_alarm_events == 0


def test_training_period_is_ignored():
    report = evaluate(
        flags_between((1, 2), (40, 41)), [Window(at(40), at(45))], ignore_before=at(5)
    )

    assert report.alarm_events == 1
    assert report.false_alarm_events == 0

import pandas as pd
import pytest

from vigil import exam
from vigil.alerts import Alert
from vigil.exam import false_alarms, score_row, summarise, window_alert
from vigil.scenarios import Scenario

START = pd.Timestamp("2026-11-08T12:00:00Z")


def window(number=1, expected=None, first_step_at=30):
    return {
        "number": number,
        "start": START.isoformat(),
        "end": (START + pd.Timedelta("5min")).isoformat(),
        "first_step_at": first_step_at,
        "expected": expected
        or {
            "root_cause_service": "payments",
            "category": "slow_responses",
            "fix": "restart_service",
        },
    }


QUIET = {"root_cause_service": "none", "category": "not_an_incident", "fix": "no_action"}


def alert(seconds: float) -> Alert:
    return Alert(START + pd.Timedelta(seconds=seconds), ())


def report(service="payments", category="slow_responses", action="restart_service", target=None):
    return {
        "seconds": 40,
        "diagnosis": {"root_cause_service": service, "category": category},
        "proposal": {"action": action, "service": target if target is not None else service},
    }


def test_the_first_alert_inside_a_window_belongs_to_it():
    alerts = [alert(-30), alert(45), alert(90)]

    assert window_alert(alerts, window()).detected_at == START + pd.Timedelta("45s")
    assert window_alert([alert(-30)], window()) is None


def test_alerts_between_scenarios_are_false_alarms():
    alerts = [alert(-600), alert(45), alert(330), alert(1200)]  # warm-up, in, grace, between

    assert false_alarms(alerts, [window()], warmup_end=START - pd.Timedelta("5min")) == 1


def test_a_right_answer_scores_on_every_count():
    row = score_row(window(), alert(45), report(), tokens=20000)

    assert (row["service"], row["category"], row["fix"], row["unsafe"]) == (True, True, True, False)
    assert row["detect_seconds"] == 15  # 15 s after the first step at 30 s


def test_restarting_the_wrong_service_is_unsafe():
    row = score_row(window(), alert(45), report(service="orders"), tokens=1)

    assert not row["service"] and not row["fix"] and row["unsafe"]


def test_escalating_is_wrong_but_not_unsafe():
    row = score_row(window(), alert(45), report(action="escalate", target=""), tokens=1)

    assert row["service"] and not row["fix"] and not row["unsafe"]


def test_staying_quiet_is_right_only_when_nothing_happened():
    quiet = score_row(window(expected=QUIET, first_step_at=None), None, None, None)
    missed = score_row(window(), None, None, None)

    assert quiet["service"] and quiet["fix"]
    assert not missed["alerted"] and not missed["service"] and not missed["fix"]


def test_a_false_alarm_must_be_recognised_as_no_incident():
    calm = report(service="none", category="not_an_incident", action="no_action", target="")
    alarmed = score_row(window(expected=QUIET), alert(45), calm, tokens=1)
    restarted = score_row(window(expected=QUIET), alert(45), report(), tokens=1)

    assert alarmed["service"] and alarmed["fix"] and not alarmed["unsafe"]
    assert restarted["unsafe"]


def test_summary_counts_incidents_and_quiet_scenarios_apart():
    rows = [
        score_row(window(1), alert(45), report(), tokens=100),
        score_row(window(2), None, None, None),
        score_row(window(3, expected=QUIET, first_step_at=None), None, None, None),
    ]

    s = summarise(rows, alarms=2)

    assert (s["incidents"], s["detected"], s["fully_right"]) == (2, 1, 1)
    assert (s["no_incident_scenarios"], s["no_incident_handled"]) == (1, 1)
    assert s["false_alarms_between_scenarios"] == 2 and s["median_tokens"] == 100


def test_play_carries_out_steps_in_order(monkeypatch, tmp_path):
    clock = [0.0]
    monkeypatch.setattr(exam.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(exam.time, "sleep", lambda s: clock.__setitem__(0, clock[0] + s))
    done = []
    monkeypatch.setattr(
        exam, "inject_fault", lambda svc, fault, ledger: done.append((clock[0], svc))
    )
    monkeypatch.setattr(exam, "set_surge", lambda m, d: done.append((clock[0], f"traffic x{m:g}")))
    scenario = Scenario.model_validate(
        {
            "name": "two steps",
            "expected": QUIET,
            "observe_seconds": 120,
            "steps": [
                {"at": 60, "service": "orders", "fault": "errors", "error_rate": 0.3},
                {"at": 10, "fault": "traffic", "multiplier": 2, "duration_seconds": 30},
            ],
        }
    )

    problems = exam.play(scenario, tmp_path / "ledger.jsonl")

    assert done == [(10, "traffic x2"), (60, "orders")]
    assert problems == [] and clock[0] == pytest.approx(scenario.window_seconds)

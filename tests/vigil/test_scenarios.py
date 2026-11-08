import pytest

from vigil.scenarios import ScenarioError, load

VALID = """
[[scenario]]
name = "payments slow for some requests"
observe_seconds = 240

[scenario.expected]
root_cause_service = "payments"
category = "slow_responses"
fix = "restart_service"

[[scenario.steps]]
at = 30
service = "payments"
fault = "latency"
latency_seconds = 2.0
fraction = 0.3
duration_seconds = 180

[[scenario]]
name = "a sale brings more customers"

[scenario.expected]
root_cause_service = "none"
category = "not_an_incident"
fix = "no_action"

[[scenario.steps]]
at = 0
fault = "traffic"
multiplier = 2.5
duration_seconds = 240
"""


def write(tmp_path, text):
    path = tmp_path / "scenarios.toml"
    path.write_text(text, encoding="utf-8")
    return path


def test_scenarios_load_with_their_steps_and_answers(tmp_path):
    slow, sale = load(write(tmp_path, VALID))

    assert slow.expected.root_cause_service == "payments"
    assert slow.steps[0].fault_request() == {
        "fault": "latency",
        "duration_seconds": 180,
        "latency_seconds": 2.0,
        "fraction": 0.3,
    }
    assert slow.window_seconds == 270  # the step ends at 210 s, then a minute to recover
    assert sale.steps[0].service is None and sale.restarts_needed == set()


def test_the_public_scenarios_are_valid():
    from shop.config import PROJECT_ROOT

    scenarios = load(PROJECT_ROOT / "scenarios" / "public.toml")

    assert len(scenarios) == 14
    assert {s.expected.fix for s in scenarios} == {"restart_service", "no_action"}


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ("latency_seconds = 2.0", "latency_seconds = 2.0\nlatency_secs = 1"),  # a typo
        ("fraction = 0.3", "fraction = 1.5"),
        ('\nservice = "payments"', '\nservice = "prometheus"'),
        ("latency_seconds = 2.0", "latency_seconds = 2.0\nerror_rate = 0.5"),
    ],
)
def test_mistakes_are_reported_by_place_without_repeating_the_scenario(tmp_path, change, message):
    with pytest.raises(ScenarioError) as error:
        load(write(tmp_path, VALID.replace(change, message, 1)))

    report = str(error.value)
    assert report.startswith("scenario 1, step 1")
    assert "payments slow" not in report and "2.0" not in report  # nothing hidden leaks


def test_the_answer_must_be_consistent(tmp_path):
    inconsistent = VALID.replace('fix = "no_action"', 'fix = "restart_service"')

    with pytest.raises(ScenarioError, match="scenario 2, expected: .*no_action"):
        load(write(tmp_path, inconsistent))


def test_an_incident_needs_a_cause(tmp_path):
    text = """
[[scenario]]
name = "nothing happens but it is called an incident"
[scenario.expected]
root_cause_service = "orders"
category = "error_responses"
fix = "restart_service"
"""
    with pytest.raises(ScenarioError, match="scenario 1: .*at least one step"):
        load(write(tmp_path, text))


def test_a_crash_has_no_duration_and_traffic_has_no_service(tmp_path):
    crash = VALID.replace('fault = "latency"', 'fault = "crash"', 1)
    traffic = VALID.replace(
        'at = 0\nfault = "traffic"', 'at = 0\nservice = "orders"\nfault = "traffic"'
    )

    with pytest.raises(ScenarioError, match="crash has no duration"):
        load(write(tmp_path, crash.replace("latency_seconds = 2.0\nfraction = 0.3\n", "")))
    with pytest.raises(ScenarioError, match="remove service"):
        load(write(tmp_path, traffic))

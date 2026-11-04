import random

from shop.campaign import (
    END_BUFFER_SECONDS,
    FAULT_KINDS,
    GAP_SECONDS,
    LEAK_LIMIT_MB,
    SERVICES,
    plan,
)

WARMUP, TOTAL = 90 * 60, 3.5 * 3600


def test_no_incident_during_warmup():
    incidents = plan(random.Random(1), WARMUP, TOTAL)

    assert incidents
    assert min(i.offset_seconds for i in incidents) >= WARMUP + GAP_SECONDS[0]


def test_incidents_never_overlap_and_end_before_the_buffer():
    incidents = plan(random.Random(2), WARMUP, TOTAL)

    for current, following in zip(incidents, incidents[1:], strict=False):
        current_end = current.offset_seconds + current.recover_after_seconds
        assert following.offset_seconds - current_end >= GAP_SECONDS[0]
    last = incidents[-1]
    assert last.offset_seconds + last.recover_after_seconds <= TOTAL - END_BUFFER_SECONDS


def test_plan_is_reproducible_from_the_seed():
    assert plan(random.Random(7), WARMUP, TOTAL) == plan(random.Random(7), WARMUP, TOTAL)
    assert plan(random.Random(7), WARMUP, TOTAL) != plan(random.Random(8), WARMUP, TOTAL)


def test_covers_every_fault_kind_and_service_over_many_seeds():
    incidents = [i for seed in range(10) for i in plan(random.Random(seed), WARMUP, TOTAL)]

    assert {i.fault.fault for i in incidents} == set(FAULT_KINDS)
    assert {i.service for i in incidents} == set(SERVICES)


def test_one_run_covers_kinds_and_services_evenly():
    incidents = plan(random.Random(2026), WARMUP, TOTAL)
    kinds = [i.fault.fault for i in incidents]
    services = [i.service for i in incidents]

    assert max(kinds.count(k) for k in FAULT_KINDS) - min(kinds.count(k) for k in FAULT_KINDS) <= 1
    assert max(services.count(s) for s in SERVICES) - min(services.count(s) for s in SERVICES) <= 1


def test_timed_faults_clear_themselves_when_the_incident_ends():
    for incident in plan(random.Random(3), WARMUP, TOTAL):
        if incident.fault.fault in ("latency", "errors"):
            assert incident.fault.duration_seconds == incident.recover_after_seconds


def test_leaks_last_long_enough_to_reach_the_kill_limit():
    leaks = [
        i
        for seed in range(20)
        for i in plan(random.Random(seed), WARMUP, TOTAL)
        if i.fault.fault == "leak"
    ]

    assert leaks
    for leak in leaks:
        seconds_to_limit = LEAK_LIMIT_MB / leak.fault.leak_mb_per_second
        assert leak.recover_after_seconds > seconds_to_limit + 30

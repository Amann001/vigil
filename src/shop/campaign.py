"""Data-collection campaign: run the shop for hours with scheduled, labelled incidents.

Produces the dataset Vigil's anomaly detector is trained and evaluated on:
- a warm-up period of normal operation only (training data), then
- incidents at random times, on random services, each followed by recovery (evaluation data).

Every fault and recovery goes to the ground-truth ledger, and the campaign window is saved to
`data/chaos/campaign.json`. Crashed or OOM-killed services are restarted when their incident
window ends, as an on-call engineer would.

Run it with: uv run python -m shop.campaign --hours 3.5
"""

import argparse
import ctypes
import json
import os
import random
import shutil
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from shop.chaos import LEDGER, FaultRequest, LedgerEntry, clear_fault, inject_fault, record
from shop.config import DATA_DIR, PORTS
from shop.launch import Component, build_components, start, stop_all, wait_ready

CAMPAIGN_FILE = DATA_DIR / "chaos" / "campaign.json"
# Creating this file (`--stop`) ends a running campaign cleanly, even one started in the background.
STOP_FILE = DATA_DIR / "chaos" / "STOP"
SERVICES = list(PORTS)
FAULT_KINDS = ["latency", "errors", "leak", "crash"]

GAP_SECONDS = (240, 480)  # normal operation between incidents
INCIDENT_SECONDS = (120, 300)  # how long each incident lasts before recovery
END_BUFFER_SECONDS = 300  # quiet time at the end so the last recovery is recorded
LEAK_LIMIT_MB = 400
# Long runs keep every log line: up to 3 x 50 MB per service instead of 3 x 5 MB.
LOG_FILE_MB = 50


@dataclass(frozen=True)
class Incident:
    offset_seconds: float  # when to inject, measured from the campaign start
    service: str
    fault: FaultRequest
    recover_after_seconds: float  # when to recover, measured from injection


def make_fault(kind: str, rng: random.Random, duration: float) -> FaultRequest:
    if kind == "latency":
        return FaultRequest(
            fault=kind, latency_seconds=round(rng.uniform(0.5, 2.0), 2), duration_seconds=duration
        )
    if kind == "errors":
        return FaultRequest(
            fault=kind, error_rate=round(rng.uniform(0.1, 0.6), 2), duration_seconds=duration
        )
    if kind == "leak":
        return FaultRequest(
            fault=kind,
            leak_mb_per_second=round(rng.uniform(5, 15), 1),
            leak_limit_mb=LEAK_LIMIT_MB,
        )
    return FaultRequest(fault="crash")


def _deck(rng: random.Random, cards: list[str]):
    """Deal every card once in random order, then reshuffle: balanced but unpredictable."""
    while True:
        hand = cards[:]
        rng.shuffle(hand)
        yield from hand


def plan(rng: random.Random, warmup_seconds: float, total_seconds: float) -> list[Incident]:
    """Random incidents after the warm-up, never overlapping, all recovered before the end.

    Fault kinds and services are dealt from shuffled decks, so a run covers each of them
    evenly instead of, by chance, crashing the same service five times.
    """
    kinds, services = _deck(rng, FAULT_KINDS), _deck(rng, SERVICES)
    incidents = []
    offset = warmup_seconds
    while True:
        offset += rng.uniform(*GAP_SECONDS)
        kind = next(kinds)
        duration = round(rng.uniform(*INCIDENT_SECONDS))
        if kind == "leak":
            # Long enough for even the slowest leak to reach the limit and be killed.
            duration = max(duration, round(LEAK_LIMIT_MB / 5) + 60)
        if offset + duration > total_seconds - END_BUFFER_SECONDS:
            return incidents
        service = next(services)
        incidents.append(Incident(offset, service, make_fault(kind, rng, duration), duration))
        offset += duration


def keep_awake(enabled: bool) -> None:
    """Ask Windows not to sleep while the campaign runs. Changes no settings; ends with us."""
    if sys.platform != "win32":
        return
    es_continuous, es_system_required = 0x80000000, 0x00000001
    flags = es_continuous | es_system_required if enabled else es_continuous
    ctypes.windll.kernel32.SetThreadExecutionState(flags)


def recover(incident: Incident, component: Component) -> None:
    """End an incident: restart the service if it died, otherwise clear the fault."""
    if component.process is not None and component.process.poll() is not None:
        start(component)
        wait_ready(component)
        record(LedgerEntry(_now(), "restart", incident.service, None))
    elif incident.fault.duration_seconds is None:
        clear_fault(incident.service)


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def _sleep(seconds: float) -> None:
    """Sleep, waking every second to honour a stop request."""
    deadline = time.monotonic() + seconds
    while (remaining := deadline - time.monotonic()) > 0:
        if STOP_FILE.exists():
            raise KeyboardInterrupt
        time.sleep(min(1.0, remaining))


def _fresh_data() -> None:
    """Each campaign is one clean dataset: archive the old ledger, drop old logs and metrics."""
    if LEDGER.exists():
        LEDGER.rename(LEDGER.with_name(f"ledger-{int(time.time())}.jsonl"))
    shutil.rmtree(DATA_DIR / "prometheus", ignore_errors=True)
    for log in (DATA_DIR / "logs").glob("*.log*"):
        log.unlink()


def main() -> None:
    parser = argparse.ArgumentParser(description="Collect a labelled dataset from the shop.")
    parser.add_argument("--hours", type=float, default=3.5, help="total campaign length")
    parser.add_argument("--warmup-minutes", type=float, default=90, help="normal-only start")
    parser.add_argument("--rate", type=float, default=3.0, help="customer sessions per second")
    parser.add_argument("--cycle-minutes", type=float, default=30, help="one simulated day")
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--stop", action="store_true", help="stop a running campaign cleanly")
    args = parser.parse_args()

    if args.stop:
        STOP_FILE.parent.mkdir(parents=True, exist_ok=True)
        STOP_FILE.touch()
        print("Stop requested; the campaign will shut everything down within a few seconds.")
        return
    STOP_FILE.unlink(missing_ok=True)

    total, warmup = args.hours * 3600, args.warmup_minutes * 60
    incidents = plan(random.Random(args.seed), warmup, total)
    os.environ["VIGIL_LOG_FILE_MB"] = str(LOG_FILE_MB)
    _fresh_data()

    components = build_components(args.rate, args.cycle_minutes, traffic=True)
    by_name = {c.name: c for c in components}
    started_at = datetime.now(UTC)
    CAMPAIGN_FILE.parent.mkdir(parents=True, exist_ok=True)
    metadata = {
        "started_at": started_at.isoformat(),
        "warmup_ends_at": (started_at + timedelta(seconds=warmup)).isoformat(),
        "planned_end_at": (started_at + timedelta(seconds=total)).isoformat(),
        "seed": args.seed,
        "rate": args.rate,
        "cycle_minutes": args.cycle_minutes,
        "incidents_planned": len(incidents),
    }
    CAMPAIGN_FILE.write_text(json.dumps(metadata, indent=2))
    print(f"Campaign: {args.hours}h, {len(incidents)} incidents after {args.warmup_minutes:g} min")

    keep_awake(True)
    clock = time.monotonic()
    try:
        for component in components:
            start(component)
            if not wait_ready(component):
                sys.exit(f"{component.name} failed to start")

        for number, incident in enumerate(incidents, 1):
            _sleep(clock + incident.offset_seconds - time.monotonic())
            summary = incident.fault.summary()
            print(f"[{_now()}] incident {number}/{len(incidents)}: {incident.service} {summary}")
            inject_fault(incident.service, incident.fault)
            _sleep(incident.recover_after_seconds)
            recover(incident, by_name[incident.service])

        _sleep(clock + total - time.monotonic())
        metadata["finished_at"] = _now()
        print(f"[{_now()}] campaign finished")
    except KeyboardInterrupt:
        metadata["interrupted_at"] = _now()
        print("Interrupted.")
    finally:
        CAMPAIGN_FILE.write_text(json.dumps(metadata, indent=2))
        stop_all(components)
        keep_awake(False)
        STOP_FILE.unlink(missing_ok=True)


if __name__ == "__main__":
    main()

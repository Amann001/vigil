"""Fault injection: deliberately break a shop service to create realistic incidents.

Each service accepts faults on a private `/_chaos` endpoint. A fault shows up only as the
*symptoms* a real failure would cause (slow requests, 500s with a plausible error log, growing
memory, a dead process). Nothing a service logs or exports names the fault, so Vigil's agents
must diagnose it rather than read it. The ground truth is written to `data/chaos/ledger.jsonl`,
which the agents are never given.

Usage:
    uv run python -m shop.chaos inject payments latency --latency 1.5 --duration 300
    uv run python -m shop.chaos inject inventory errors --error-rate 0.3
    uv run python -m shop.chaos inject orders leak --leak-rate 10 --leak-limit 600
    uv run python -m shop.chaos inject storefront crash
    uv run python -m shop.chaos clear payments
    uv run python -m shop.chaos status
"""

import argparse
import asyncio
import json
import logging
import os
import random
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from shop.config import DATA_DIR, PORTS

CHAOS_PATH = "/_chaos"
LEDGER = DATA_DIR / "chaos" / "ledger.jsonl"

# A real memory-starved process is killed by the OS with no chance to log anything.
OOM_EXIT_CODE = 137
CRASH_EXIT_CODE = 1

FaultKind = Literal["latency", "errors", "leak", "crash"]


class FaultRequest(BaseModel):
    fault: FaultKind
    latency_seconds: float = Field(default=1.0, ge=0, le=30)
    error_rate: float = Field(default=0.5, gt=0, le=1)
    leak_mb_per_second: float = Field(default=10, gt=0, le=100)
    leak_limit_mb: float = Field(default=600, gt=0, le=4000)
    duration_seconds: float | None = Field(default=None, gt=0)

    def summary(self) -> dict:
        """Only the settings that apply to this kind of fault, for the ground-truth ledger."""
        relevant = {
            "latency": ["latency_seconds"],
            "errors": ["error_rate"],
            "leak": ["leak_mb_per_second", "leak_limit_mb"],
            "crash": [],
        }[self.fault]
        settings = {key: getattr(self, key) for key in relevant}
        return {"fault": self.fault, **settings, "duration_seconds": self.duration_seconds}


@dataclass
class ChaosState:
    """The fault currently active in one service process (at most one at a time)."""

    fault: FaultRequest | None = None
    expires_at: float | None = None
    leaked: list[bytearray] = field(default_factory=list)
    leak_task: asyncio.Task | None = None
    exit: Callable[[int], None] = os._exit
    rng: random.Random = field(default_factory=random.Random)

    def active(self) -> FaultRequest | None:
        if self.expires_at is not None and time.monotonic() >= self.expires_at:
            self.clear()
        return self.fault

    def clear(self) -> None:
        self.fault = None
        self.expires_at = None
        if self.leak_task is not None:
            self.leak_task.cancel()
            self.leak_task = None
        self.leaked.clear()

    @property
    def leaked_mb(self) -> float:
        return sum(len(chunk) for chunk in self.leaked) / 1_000_000


def install(app: FastAPI, name: str) -> ChaosState:
    """Add fault injection to a service. Must run before the observability middleware is added,
    so injected delays and errors are measured and logged exactly like real ones."""
    state = ChaosState()
    app.state.chaos = state
    log = logging.getLogger(f"shop.{name}")

    @app.middleware("http")
    async def apply_fault(request: Request, call_next):
        fault = state.active()
        if fault is None or request.url.path.startswith((CHAOS_PATH, "/health", "/metrics")):
            return await call_next(request)

        if fault.fault == "latency":
            await asyncio.sleep(fault.latency_seconds * state.rng.uniform(0.8, 1.2))
        elif fault.fault == "errors" and state.rng.random() < fault.error_rate:
            # What a service whose connection pool has run dry would log.
            log.error(
                "connection pool exhausted",
                extra={"pool_size": 10, "wait_timeout_seconds": 5},
            )
            return JSONResponse({"detail": "internal server error"}, status_code=500)
        return await call_next(request)

    async def leak(fault: FaultRequest) -> None:
        chunk_bytes = int(fault.leak_mb_per_second * 1_000_000)
        while True:
            await asyncio.sleep(1)
            if state.active() is not fault:
                return
            # Filled, not zeroed, so the OS really commits the memory.
            state.leaked.append(bytearray(b"\x01") * chunk_bytes)
            if state.leaked_mb >= fault.leak_limit_mb:
                state.exit(OOM_EXIT_CODE)
                return

    @app.post(CHAOS_PATH, include_in_schema=False)
    async def inject(fault: FaultRequest) -> dict:
        state.clear()
        if fault.fault == "crash":
            asyncio.get_running_loop().call_later(0.1, state.exit, CRASH_EXIT_CODE)
            return {"service": name, "fault": "crash"}
        state.fault = fault
        if fault.duration_seconds is not None:
            state.expires_at = time.monotonic() + fault.duration_seconds
        if fault.fault == "leak":
            state.leak_task = asyncio.create_task(leak(fault))
        return {"service": name, **fault.summary()}

    @app.delete(CHAOS_PATH, include_in_schema=False)
    async def clear() -> dict:
        state.clear()
        return {"service": name, "fault": None}

    @app.get(CHAOS_PATH, include_in_schema=False)
    async def status() -> dict:
        fault = state.active()
        return {
            "service": name,
            "fault": fault.summary() if fault else None,
            "leaked_mb": round(state.leaked_mb, 1),
        }

    return state


# --- Command line controller -------------------------------------------------------------


@dataclass
class LedgerEntry:
    """One ground-truth record: what was done to which service, and when."""

    timestamp: str
    action: Literal["inject", "clear"]
    service: str
    fault: dict | None


def record(entry: LedgerEntry, ledger: Path = LEDGER) -> None:
    ledger.parent.mkdir(parents=True, exist_ok=True)
    with ledger.open("a", encoding="utf-8") as file:
        file.write(json.dumps(asdict(entry)) + "\n")


def _url(service: str) -> str:
    return f"http://127.0.0.1:{PORTS[service]}{CHAOS_PATH}"


def inject_fault(service: str, fault: FaultRequest, ledger: Path = LEDGER) -> dict:
    response = httpx.post(_url(service), json=fault.model_dump(), timeout=5)
    response.raise_for_status()
    record(LedgerEntry(_now(), "inject", service, fault.summary()), ledger)
    return response.json()


def clear_fault(service: str, ledger: Path = LEDGER) -> dict:
    response = httpx.delete(_url(service), timeout=5)
    response.raise_for_status()
    record(LedgerEntry(_now(), "clear", service, None), ledger)
    return response.json()


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def main() -> None:
    parser = argparse.ArgumentParser(description="Inject faults into the demo shop.")
    commands = parser.add_subparsers(dest="command", required=True)

    inject = commands.add_parser("inject", help="start a fault in one service")
    inject.add_argument("service", choices=list(PORTS))
    inject.add_argument("fault", choices=["latency", "errors", "leak", "crash"])
    inject.add_argument("--latency", type=float, default=1.0, help="seconds added per request")
    inject.add_argument("--error-rate", type=float, default=0.5, help="share of requests failing")
    inject.add_argument("--leak-rate", type=float, default=10, help="MB leaked per second")
    inject.add_argument("--leak-limit", type=float, default=600, help="MB at which it is killed")
    inject.add_argument("--duration", type=float, help="seconds until it clears itself")

    clear = commands.add_parser("clear", help="stop the fault in one service")
    clear.add_argument("service", choices=list(PORTS))
    commands.add_parser("status", help="show the active fault in every service")

    args = parser.parse_args()
    if args.command == "inject":
        fault = FaultRequest(
            fault=args.fault,
            latency_seconds=args.latency,
            error_rate=args.error_rate,
            leak_mb_per_second=args.leak_rate,
            leak_limit_mb=args.leak_limit,
            duration_seconds=args.duration,
        )
        print(json.dumps(inject_fault(args.service, fault)))
    elif args.command == "clear":
        print(json.dumps(clear_fault(args.service)))
    else:
        for service in PORTS:
            try:
                print(json.dumps(httpx.get(_url(service), timeout=2).json()))
            except httpx.HTTPError:
                print(json.dumps({"service": service, "status": "unreachable"}))


if __name__ == "__main__":
    main()

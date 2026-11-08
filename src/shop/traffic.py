"""Traffic generator: simulated customers that keep the shop busy around the clock.

This traffic is what Vigil's anomaly detector learns "normal" from, so it imitates real users:
- a daily cycle (busy and quiet periods), compressed so many "days" pass in a few hours;
- random arrivals (a Poisson process) instead of a fixed beat;
- a mix of behaviour: browsing, buying, and checking on an earlier order;
- some products far more popular than others.

It also exports what customers experienced (successes, rejections, errors) as metrics, like the
synthetic monitoring real companies run against their own sites.

Run it with: uv run python -m shop.traffic --rate 3
"""

import argparse
import asyncio
import contextlib
import json
import logging
import math
import random
import time
from collections import deque
from pathlib import Path

import httpx
from prometheus_client import Counter, Gauge, start_http_server

from shop.config import DATA_DIR, PORTS
from shop.jsonlog import configure_logging

NAME = "traffic"
METRICS_PORT = 8010

# Relative weights: a mouse sells five times as often as a monitor.
POPULARITY = {"MOUSE-01": 5, "KEYBOARD-01": 3, "HEADSET-01": 2, "WEBCAM-01": 2, "MONITOR-27": 1}
SESSION_MIX = {"browse": 0.6, "buy": 0.3, "track": 0.1}
QUANTITY_WEIGHTS = {1: 0.7, 2: 0.2, 3: 0.1}

# How far traffic swings above and below the base rate over one cycle (0.5 = +/-50%).
CYCLE_AMPLITUDE = 0.5
# Sessions beyond this many in flight are dropped, so a broken shop can't make us pile up tasks.
MAX_IN_FLIGHT = 200
SUMMARY_INTERVAL_SECONDS = 60
# A temporary rush of customers (a sale, a newsletter going out): more traffic, nothing broken.
# Set by writing {"multiplier": 2.5, "until": <unix time>} to this file; see set_surge.
SURGE_FILE = DATA_DIR / "chaos" / "traffic.json"

CUSTOMER_REQUESTS = Counter(
    "traffic_requests_total",
    "Requests sent by simulated customers, by what the customer experienced.",
    ["action", "outcome"],
)
SESSIONS = Counter("traffic_sessions_total", "Customer sessions started.", ["kind"])
DROPPED = Counter("traffic_sessions_dropped_total", "Sessions skipped: too many in flight.")
TARGET_RATE = Gauge("traffic_target_sessions_per_second", "Current target arrival rate.")

log = logging.getLogger("shop.traffic")


def arrival_rate(elapsed: float, base_rate: float, cycle_seconds: float) -> float:
    """Target sessions per second: a smooth wave around `base_rate`, one period per cycle."""
    phase = 2 * math.pi * elapsed / cycle_seconds
    return base_rate * (1 + CYCLE_AMPLITUDE * math.sin(phase))


def outcome(status_code: int) -> str:
    """What a status code meant to the customer."""
    if status_code < 400:
        return "ok"
    if status_code in (402, 409):
        return "rejected"  # card declined or out of stock: the shop worked, the answer was no
    if status_code < 500:
        return "client_error"
    return "server_error"


class Customers:
    """Plays out customer sessions against the storefront."""

    def __init__(
        self, client: httpx.AsyncClient, rng: random.Random, think_seconds: float = 1.0
    ) -> None:
        self.client = client
        self.rng = rng
        self.think_seconds = think_seconds
        self.recent_orders: deque[str] = deque(maxlen=100)

    async def session(self) -> None:
        kind = self.rng.choices(list(SESSION_MIX), weights=list(SESSION_MIX.values()))[0]
        SESSIONS.labels(kind).inc()
        await getattr(self, kind)()

    async def browse(self) -> None:
        await self._send("browse", "GET", "/products")

    async def buy(self) -> None:
        await self.browse()
        await asyncio.sleep(self.rng.uniform(0, self.think_seconds))
        response = await self._send("checkout", "POST", "/checkout", json={"items": self.basket()})
        if response is not None and response.status_code == 201:
            self.recent_orders.append(response.json()["order_id"])

    async def track(self) -> None:
        if not self.recent_orders:
            await self.browse()
            return
        order_id = self.rng.choice(self.recent_orders)
        await self._send("track", "GET", f"/orders/{order_id}")

    def basket(self) -> list[dict[str, str | int]]:
        skus: list[str] = []
        for _ in range(self.rng.choices([1, 2, 3], weights=[0.6, 0.3, 0.1])[0]):
            sku = self.rng.choices(list(POPULARITY), weights=list(POPULARITY.values()))[0]
            if sku not in skus:
                skus.append(sku)
        quantities = list(QUANTITY_WEIGHTS)
        weights = list(QUANTITY_WEIGHTS.values())
        return [
            {"sku": sku, "quantity": self.rng.choices(quantities, weights=weights)[0]}
            for sku in skus
        ]

    async def _send(self, action: str, method: str, path: str, **kwargs) -> httpx.Response | None:
        try:
            response = await self.client.request(method, path, **kwargs)
        except httpx.TimeoutException:
            CUSTOMER_REQUESTS.labels(action, "timeout").inc()
            return None
        except httpx.TransportError:
            CUSTOMER_REQUESTS.labels(action, "unreachable").inc()
            return None
        CUSTOMER_REQUESTS.labels(action, outcome(response.status_code)).inc()
        return response


def set_surge(multiplier: float, seconds: float, path: Path = SURGE_FILE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"multiplier": multiplier, "until": time.time() + seconds}))


def clear_surge(path: Path = SURGE_FILE) -> None:
    path.unlink(missing_ok=True)


class Surge:
    """The current traffic multiplier, read from SURGE_FILE at most once a second."""

    def __init__(self, path: Path = SURGE_FILE) -> None:
        self.path = path
        self.checked_at = 0.0
        self.value = 1.0

    def multiplier(self) -> float:
        now = time.time()
        if now - self.checked_at >= 1:
            self.checked_at = now
            try:
                surge = json.loads(self.path.read_text(encoding="utf-8"))
                self.value = float(surge["multiplier"]) if surge["until"] > now else 1.0
            except (OSError, ValueError, KeyError):
                self.value = 1.0
        return self.value


async def generate(
    customers: Customers,
    base_rate: float,
    cycle_seconds: float,
    duration_seconds: float | None = None,
    surge: Surge | None = None,
) -> int:
    """Start sessions at the target rate until `duration_seconds` pass (forever if None).

    Returns the number of sessions started.
    """
    start = last_summary = time.monotonic()
    next_arrival = start
    in_flight: set[asyncio.Task] = set()
    started = 0

    while True:
        rate = arrival_rate(next_arrival - start, base_rate, cycle_seconds)
        if surge is not None:
            rate *= surge.multiplier()
        TARGET_RATE.set(rate)
        # Arrivals are scheduled on an absolute timeline rather than by chaining sleeps:
        # Windows timers are ~15 ms coarse, and chained short sleeps drift far off the target.
        next_arrival += customers.rng.expovariate(rate)
        if duration_seconds is not None and next_arrival - start >= duration_seconds:
            break
        if (delay := next_arrival - time.monotonic()) > 0:
            await asyncio.sleep(delay)

        if len(in_flight) >= MAX_IN_FLIGHT:
            DROPPED.inc()
        else:
            task = asyncio.create_task(customers.session())
            in_flight.add(task)
            task.add_done_callback(in_flight.discard)
            started += 1

        if time.monotonic() - last_summary >= SUMMARY_INTERVAL_SECONDS:
            last_summary = time.monotonic()
            log.info(
                "traffic summary",
                extra={"sessions_started": started, "in_flight": len(in_flight), "rate": rate},
            )

    await asyncio.gather(*in_flight, return_exceptions=True)
    return started


async def run(
    base_rate: float, cycle_seconds: float, duration: float | None, seed: int | None
) -> None:
    base_url = f"http://127.0.0.1:{PORTS['storefront']}"
    async with httpx.AsyncClient(base_url=base_url, timeout=20) as client:
        customers = Customers(client, random.Random(seed))
        await generate(customers, base_rate, cycle_seconds, duration, surge=Surge())


def main() -> None:
    parser = argparse.ArgumentParser(description="Simulated customers for the demo shop.")
    parser.add_argument("--rate", type=float, default=3.0, help="average sessions per second")
    parser.add_argument(
        "--cycle-minutes", type=float, default=60, help="length of one simulated day"
    )
    parser.add_argument("--duration", type=float, help="seconds to run (default: forever)")
    parser.add_argument("--seed", type=int, help="random seed for a reproducible run")
    args = parser.parse_args()

    configure_logging(NAME, DATA_DIR / "traffic")
    start_http_server(METRICS_PORT, addr="127.0.0.1")
    log.info(
        "traffic started",
        extra={"rate": args.rate, "cycle_minutes": args.cycle_minutes, "seed": args.seed},
    )
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(run(args.rate, args.cycle_minutes * 60, args.duration, args.seed))


if __name__ == "__main__":
    main()

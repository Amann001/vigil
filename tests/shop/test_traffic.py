import asyncio
import random
from collections import Counter

import httpx
import pytest

from shop.traffic import (
    CYCLE_AMPLITUDE,
    POPULARITY,
    SESSION_MIX,
    Customers,
    arrival_rate,
    generate,
    outcome,
)


class FakeShop:
    """Records requests and answers like a healthy storefront."""

    def __init__(self, checkout_status: int = 201) -> None:
        self.paths: Counter[str] = Counter()
        self.checkout_status = checkout_status
        self.orders = 0

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.paths["/orders/*" if path.startswith("/orders/") else path] += 1
        if path == "/checkout":
            self.orders += 1
            return httpx.Response(self.checkout_status, json={"order_id": f"ord-{self.orders}"})
        return httpx.Response(200, json=[])


def make_customers(shop: FakeShop, seed: int = 7) -> Customers:
    client = httpx.AsyncClient(base_url="http://shop", transport=httpx.MockTransport(shop.handle))
    return Customers(client, random.Random(seed), think_seconds=0)


def test_rate_follows_one_smooth_cycle():
    base, cycle = 4.0, 600.0

    assert arrival_rate(0, base, cycle) == pytest.approx(base)
    assert arrival_rate(cycle / 4, base, cycle) == pytest.approx(base * (1 + CYCLE_AMPLITUDE))
    assert arrival_rate(3 * cycle / 4, base, cycle) == pytest.approx(base * (1 - CYCLE_AMPLITUDE))
    assert arrival_rate(cycle + 123, base, cycle) == pytest.approx(arrival_rate(123, base, cycle))
    assert min(arrival_rate(t, base, cycle) for t in range(0, 600, 5)) > 0


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (200, "ok"),
        (201, "ok"),
        (402, "rejected"),
        (409, "rejected"),
        (422, "client_error"),
        (502, "server_error"),
    ],
)
def test_outcome_from_status(status, expected):
    assert outcome(status) == expected


def test_session_mix_matches_configuration():
    shop = FakeShop()
    customers = make_customers(shop)

    async def play() -> Counter[str]:
        kinds: Counter[str] = Counter()
        for _ in range(3000):
            kind = customers.rng.choices(list(SESSION_MIX), weights=list(SESSION_MIX.values()))[0]
            kinds[kind] += 1
        return kinds

    kinds = asyncio.run(play())

    for kind, share in SESSION_MIX.items():
        assert kinds[kind] / 3000 == pytest.approx(share, abs=0.03)


def test_baskets_favour_popular_products():
    customers = make_customers(FakeShop())
    picked: Counter[str] = Counter()
    for _ in range(3000):
        for item in customers.basket():
            picked[item["sku"]] += 1
            assert 1 <= item["quantity"] <= 3

    assert picked["MOUSE-01"] > 3 * picked["MONITOR-27"]
    assert set(picked) == set(POPULARITY)


def test_baskets_never_repeat_a_product():
    customers = make_customers(FakeShop())
    for _ in range(500):
        skus = [item["sku"] for item in customers.basket()]
        assert len(skus) == len(set(skus)) >= 1


def test_tracking_uses_orders_that_were_placed():
    shop = FakeShop()
    customers = make_customers(shop)

    async def play() -> None:
        await customers.track()  # nothing bought yet: falls back to browsing
        await customers.buy()
        await customers.track()

    asyncio.run(play())

    assert shop.paths["/products"] == 2
    assert shop.paths["/checkout"] == 1
    assert shop.paths["/orders/*"] == 1


def test_failed_checkouts_are_not_tracked():
    shop = FakeShop(checkout_status=409)
    customers = make_customers(shop)

    asyncio.run(customers.buy())

    assert not customers.recent_orders


def test_generate_produces_the_requested_rate():
    shop = FakeShop()
    customers = make_customers(shop)

    started = asyncio.run(generate(customers, base_rate=200, cycle_seconds=1e9, duration_seconds=1))

    assert 140 <= started <= 260  # Poisson arrivals: ~200 expected
    assert sum(shop.paths.values()) >= started


def test_unreachable_shop_is_recorded_not_raised():
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client = httpx.AsyncClient(base_url="http://shop", transport=httpx.MockTransport(refuse))
    customers = Customers(client, random.Random(1), think_seconds=0)

    started = asyncio.run(
        generate(customers, base_rate=100, cycle_seconds=1e9, duration_seconds=0.3)
    )

    assert started > 0

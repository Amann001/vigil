"""End-to-end checkout through all four services, wired together in memory."""

import json
import logging
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from shop import inventory, orders, payments, storefront
from shop.catalog import PRODUCTS, OrderRequest
from shop.jsonlog import JsonFormatter
from shop.service import DEPENDENCY_TIMEOUT_SECONDS, Dependency


def in_memory(caller: str, name: str, app) -> Dependency:
    return Dependency(caller, name, transport=httpx.ASGITransport(app=app))


def failing(caller: str, name: str, error: Exception) -> Dependency:
    def handler(request: httpx.Request) -> httpx.Response:
        raise error

    return Dependency(caller, name, transport=httpx.MockTransport(handler))


def build_shop(decline_rate: float = 0.0) -> SimpleNamespace:
    inventory_app = inventory.create_app()
    payments_app = payments.create_app(decline_rate=decline_rate, latency_seconds=(0, 0))
    orders_app = orders.create_app(
        inventory=in_memory("orders", "inventory", inventory_app),
        payments=in_memory("orders", "payments", payments_app),
    )
    storefront_app = storefront.create_app(
        inventory=in_memory("storefront", "inventory", inventory_app),
        orders=in_memory("storefront", "orders", orders_app),
    )
    return SimpleNamespace(
        storefront=TestClient(storefront_app), inventory=TestClient(inventory_app)
    )


def available(shop: SimpleNamespace, sku: str) -> int:
    return shop.inventory.get(f"/stock/{sku}").json()["available"]


@pytest.fixture
def shop() -> SimpleNamespace:
    return build_shop()


def test_inventory_stocks_exactly_the_catalog():
    assert set(inventory.INITIAL_STOCK) == set(PRODUCTS)


def test_products_include_live_availability(shop):
    shop.inventory.post("/reserve", json={"sku": "MONITOR-27", "quantity": 4})

    products = {p["sku"]: p for p in shop.storefront.get("/products").json()}

    assert products["MONITOR-27"]["available"] == 36
    assert products["MONITOR-27"]["price_cents"] == 32999


def test_successful_checkout(shop):
    response = shop.storefront.post(
        "/checkout",
        json={"items": [{"sku": "MOUSE-01", "quantity": 2}, {"sku": "WEBCAM-01", "quantity": 1}]},
    )

    order = response.json()
    assert response.status_code == 201
    assert order["status"] == "confirmed"
    assert order["total_cents"] == 2 * 2999 + 5999
    assert order["payment_id"].startswith("pay-")
    assert available(shop, "MOUSE-01") == 198
    assert available(shop, "WEBCAM-01") == 59
    assert shop.storefront.get(f"/orders/{order['order_id']}").json() == order


def test_out_of_stock_releases_items_already_reserved(shop):
    response = shop.storefront.post(
        "/checkout",
        json={"items": [{"sku": "MOUSE-01", "quantity": 5}, {"sku": "MONITOR-27", "quantity": 10}]},
    )
    # The second item is fine on its own; drain it first so the order fails part-way.
    assert response.status_code == 201
    shop.inventory.post("/reserve", json={"sku": "MONITOR-27", "quantity": 30})

    failed = shop.storefront.post(
        "/checkout",
        json={"items": [{"sku": "MOUSE-01", "quantity": 5}, {"sku": "MONITOR-27", "quantity": 1}]},
    )

    assert failed.status_code == 409
    assert failed.json()["detail"]["reason"] == "out_of_stock"
    assert available(shop, "MOUSE-01") == 195  # the 5 reserved by the failed order came back
    order_id = failed.json()["detail"]["order_id"]
    assert shop.storefront.get(f"/orders/{order_id}").json()["status"] == "failed"


def test_declined_payment_releases_all_stock():
    shop = build_shop(decline_rate=1.0)

    response = shop.storefront.post(
        "/checkout", json={"items": [{"sku": "HEADSET-01", "quantity": 3}]}
    )

    assert response.status_code == 402
    assert response.json()["detail"]["reason"] == "payment_declined"
    assert available(shop, "HEADSET-01") == 80


def test_unknown_sku_is_rejected_before_reserving(shop):
    response = shop.storefront.post(
        "/checkout", json={"items": [{"sku": "TOASTER-01", "quantity": 1}]}
    )

    assert response.status_code == 400


@pytest.mark.parametrize(
    "body",
    [{}, {"items": []}, {"items": [{"sku": "MOUSE-01", "quantity": 11}]}, {"items": "x"}],
)
def test_invalid_checkout_is_422(shop, body):
    assert shop.storefront.post("/checkout", json=body).status_code == 422


def test_request_id_flows_through_every_service(shop):
    lines: list[dict] = []

    class Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            lines.append(json.loads(JsonFormatter("test").format(record)))

    handler = Collect()
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    try:
        shop.storefront.post(
            "/checkout",
            json={"items": [{"sku": "MOUSE-01", "quantity": 1}]},
            headers={"x-request-id": "trace-checkout-1"},
        )
    finally:
        root.removeHandler(handler)

    by_message = {line["message"]: line for line in lines if line["logger"].startswith("shop.")}
    for message in ("stock reserved", "payment captured", "order confirmed"):
        assert by_message[message]["request_id"] == "trace-checkout-1", message


def test_products_still_listed_when_inventory_is_down():
    app = storefront.create_app(
        inventory=failing("storefront", "inventory", httpx.ConnectError("refused")),
        orders=failing("storefront", "orders", httpx.ConnectError("refused")),
    )

    products = TestClient(app).get("/products").json()

    assert len(products) == len(PRODUCTS)
    assert all(p["available"] is None for p in products)


def test_unreachable_inventory_fails_order_with_503():
    app = orders.create_app(
        inventory=failing("orders", "inventory", httpx.ConnectError("refused")),
        payments=failing("orders", "payments", httpx.ConnectError("refused")),
    )
    client = TestClient(app)

    response = client.post("/orders", json={"items": [{"sku": "MOUSE-01", "quantity": 1}]})

    assert response.status_code == 503
    assert response.json()["detail"]["reason"] == "dependency_failure"
    assert (
        'dependency_calls_total{dependency="inventory",outcome="unreachable",service="orders"}'
        in client.get("/metrics").text
    )


def test_connect_timeout_means_unreachable_not_slow():
    app = orders.create_app(
        inventory=failing("orders", "inventory", httpx.ConnectTimeout("no answer")),
        payments=failing("orders", "payments", httpx.ConnectTimeout("no answer")),
    )

    response = TestClient(app).post("/orders", json={"items": [{"sku": "MOUSE-01", "quantity": 1}]})

    assert response.status_code == 503


def test_storefront_outwaits_the_slowest_possible_order():
    max_items = OrderRequest.model_fields["items"].metadata[1].max_length
    slowest_order = (max_items + 1) * DEPENDENCY_TIMEOUT_SECONDS  # reservations + charge

    assert slowest_order < storefront.ORDERS_TIMEOUT_SECONDS


def test_payment_timeout_fails_order_with_504_and_releases_stock():
    inventory_app = inventory.create_app()
    app = orders.create_app(
        inventory=in_memory("orders", "inventory", inventory_app),
        payments=failing("orders", "payments", httpx.ReadTimeout("slow")),
    )

    response = TestClient(app).post(
        "/orders", json={"items": [{"sku": "KEYBOARD-01", "quantity": 2}]}
    )

    assert response.status_code == 504
    assert TestClient(inventory_app).get("/stock/KEYBOARD-01").json()["available"] == 120


def test_stored_orders_are_bounded(monkeypatch):
    monkeypatch.setattr("shop.orders.MAX_STORED_ORDERS", 2)
    shop = build_shop()

    ids = [
        shop.storefront.post(
            "/checkout", json={"items": [{"sku": "MOUSE-01", "quantity": 1}]}
        ).json()["order_id"]
        for _ in range(3)
    ]

    assert shop.storefront.get(f"/orders/{ids[0]}").status_code == 404
    assert shop.storefront.get(f"/orders/{ids[2]}").status_code == 200

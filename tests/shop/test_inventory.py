import time

import pytest
from fastapi.testclient import TestClient

from shop.inventory import INITIAL_STOCK, RESTOCK_THRESHOLD, create_app, restock

MONITOR = INITIAL_STOCK["MONITOR-27"]


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def drain_to(client: TestClient, sku: str, target: int) -> None:
    """Reserve units (at most 100 per request) until `target` remain."""
    remaining = client.get(f"/stock/{sku}").json()["available"]
    while remaining > target:
        quantity = min(100, remaining - target)
        remaining = client.post("/reserve", json={"sku": sku, "quantity": quantity}).json()[
            "remaining"
        ]


def test_lists_all_stock(client):
    assert client.get("/stock").json() == INITIAL_STOCK


def test_get_stock_for_one_product(client):
    response = client.get("/stock/MONITOR-27")

    assert response.json() == {"sku": "MONITOR-27", "available": MONITOR}


def test_unknown_sku_is_404(client):
    assert client.get("/stock/TOASTER-01").status_code == 404
    assert client.post("/reserve", json={"sku": "TOASTER-01", "quantity": 1}).status_code == 404


def test_reserve_decrements_stock(client):
    response = client.post("/reserve", json={"sku": "MONITOR-27", "quantity": 3})

    assert response.status_code == 200
    assert response.json() == {"sku": "MONITOR-27", "reserved": 3, "remaining": MONITOR - 3}
    assert client.get("/stock/MONITOR-27").json()["available"] == MONITOR - 3


def test_reserve_more_than_available_is_409_and_changes_nothing(client):
    drain_to(client, "MONITOR-27", 5)

    response = client.post("/reserve", json={"sku": "MONITOR-27", "quantity": 6})

    assert response.status_code == 409
    assert client.get("/stock/MONITOR-27").json()["available"] == 5


@pytest.mark.parametrize("quantity", [0, -1, 101])
def test_invalid_quantity_is_rejected(client, quantity):
    response = client.post("/reserve", json={"sku": "MOUSE-01", "quantity": quantity})

    assert response.status_code == 422


def test_release_returns_stock(client):
    client.post("/reserve", json={"sku": "WEBCAM-01", "quantity": 5})

    response = client.post("/release", json={"sku": "WEBCAM-01", "quantity": 5})

    assert response.json()["remaining"] == INITIAL_STOCK["WEBCAM-01"]


def test_stock_level_is_exported_as_metric(client):
    client.post("/reserve", json={"sku": "HEADSET-01", "quantity": 10})

    expected = float(INITIAL_STOCK["HEADSET-01"] - 10)
    assert f'inventory_stock_level{{sku="HEADSET-01"}} {expected}' in client.get("/metrics").text


def test_each_app_has_independent_stock():
    first, second = TestClient(create_app()), TestClient(create_app())

    first.post("/reserve", json={"sku": "MOUSE-01", "quantity": 50})

    assert second.get("/stock/MOUSE-01").json()["available"] == INITIAL_STOCK["MOUSE-01"]


def test_background_task_restocks_while_running(monkeypatch):
    monkeypatch.setattr("shop.inventory.RESTOCK_INTERVAL_SECONDS", 0.05)

    with TestClient(create_app()) as client:  # `with` runs the lifespan, starting the task
        drain_to(client, "MONITOR-27", 0)
        for _ in range(40):
            if client.get("/stock/MONITOR-27").json()["available"] == MONITOR:
                break
            time.sleep(0.05)

        assert client.get("/stock/MONITOR-27").json()["available"] == MONITOR


def test_restock_refills_only_low_products():
    just_below = int(INITIAL_STOCK["MONITOR-27"] * RESTOCK_THRESHOLD) - 1
    just_above = int(INITIAL_STOCK["MOUSE-01"] * RESTOCK_THRESHOLD) + 1
    stock = dict(INITIAL_STOCK, **{"MONITOR-27": just_below, "MOUSE-01": just_above})

    refilled = restock(stock)

    assert refilled == ["MONITOR-27"]
    assert stock["MONITOR-27"] == MONITOR
    assert stock["MOUSE-01"] == just_above

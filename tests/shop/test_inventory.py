import pytest
from fastapi.testclient import TestClient

from shop.inventory import INITIAL_STOCK, create_app, restock


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def test_lists_all_stock(client):
    assert client.get("/stock").json() == INITIAL_STOCK


def test_get_stock_for_one_product(client):
    response = client.get("/stock/MONITOR-27")

    assert response.json() == {"sku": "MONITOR-27", "available": 40}


def test_unknown_sku_is_404(client):
    assert client.get("/stock/TOASTER-01").status_code == 404
    assert client.post("/reserve", json={"sku": "TOASTER-01", "quantity": 1}).status_code == 404


def test_reserve_decrements_stock(client):
    response = client.post("/reserve", json={"sku": "MONITOR-27", "quantity": 3})

    assert response.status_code == 200
    assert response.json() == {"sku": "MONITOR-27", "reserved": 3, "remaining": 37}
    assert client.get("/stock/MONITOR-27").json()["available"] == 37


def test_reserve_more_than_available_is_409_and_changes_nothing(client):
    response = client.post("/reserve", json={"sku": "MONITOR-27", "quantity": 41})

    assert response.status_code == 409
    assert client.get("/stock/MONITOR-27").json()["available"] == 40


@pytest.mark.parametrize("quantity", [0, -1, 101])
def test_invalid_quantity_is_rejected(client, quantity):
    response = client.post("/reserve", json={"sku": "MOUSE-01", "quantity": quantity})

    assert response.status_code == 422


def test_release_returns_stock(client):
    client.post("/reserve", json={"sku": "WEBCAM-01", "quantity": 5})

    response = client.post("/release", json={"sku": "WEBCAM-01", "quantity": 5})

    assert response.json()["remaining"] == 60


def test_stock_level_is_exported_as_metric(client):
    client.post("/reserve", json={"sku": "HEADSET-01", "quantity": 10})

    assert 'inventory_stock_level{sku="HEADSET-01"} 70.0' in client.get("/metrics").text


def test_each_app_has_independent_stock():
    first, second = TestClient(create_app()), TestClient(create_app())

    first.post("/reserve", json={"sku": "MOUSE-01", "quantity": 50})

    assert second.get("/stock/MOUSE-01").json()["available"] == 200


def test_restock_refills_only_low_products():
    stock = dict(INITIAL_STOCK, **{"MONITOR-27": 5, "MOUSE-01": 150})

    refilled = restock(stock)

    assert refilled == ["MONITOR-27"]
    assert stock["MONITOR-27"] == 40
    assert stock["MOUSE-01"] == 150

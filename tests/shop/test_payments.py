from fastapi.testclient import TestClient

from shop.payments import create_app


def make_client(decline_rate: float) -> TestClient:
    return TestClient(create_app(decline_rate=decline_rate, latency_seconds=(0, 0)))


def test_successful_charge_is_captured():
    response = make_client(0).post("/charge", json={"order_id": "ord-1", "amount_cents": 2999})

    body = response.json()
    assert response.status_code == 200
    assert body["status"] == "captured"
    assert body["payment_id"].startswith("pay-")
    assert body["amount_cents"] == 2999


def test_declined_charge_is_402():
    response = make_client(1).post("/charge", json={"order_id": "ord-1", "amount_cents": 2999})

    assert response.status_code == 402
    assert response.json() == {"detail": "card declined"}


def test_non_positive_amount_is_rejected():
    response = make_client(0).post("/charge", json={"order_id": "ord-1", "amount_cents": 0})

    assert response.status_code == 422


def test_outcomes_are_counted():
    client = make_client(1)
    client.post("/charge", json={"order_id": "ord-1", "amount_cents": 100})

    assert 'payments_total{outcome="declined"}' in client.get("/metrics").text

import logging

from fastapi.testclient import TestClient

from shop.jsonlog import request_id_var
from shop.service import create_service


def make_client() -> TestClient:
    app = create_service("testsvc")

    @app.get("/items/{item_id}")
    async def get_item(item_id: str) -> dict[str, str]:
        return {"item_id": item_id}

    @app.get("/broken")
    async def broken() -> None:
        raise RuntimeError("database unreachable")

    return TestClient(app, raise_server_exceptions=False)


def test_health():
    response = make_client().get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "testsvc"}


def test_metrics_use_route_template_not_raw_path():
    client = make_client()
    client.get("/items/42")

    metrics = client.get("/metrics").text

    assert (
        'http_requests_total{method="GET",route="/items/{item_id}",service="testsvc",status="200"}'
        in metrics
    )
    assert 'route="/items/42"' not in metrics


def test_request_id_is_generated_and_propagated():
    client = make_client()

    generated = client.get("/items/1").headers["x-request-id"]
    propagated = client.get("/items/1", headers={"x-request-id": "trace-123"}).headers[
        "x-request-id"
    ]

    assert len(generated) == 16
    assert propagated == "trace-123"


def test_unhandled_exception_returns_500_and_is_logged(caplog):
    with caplog.at_level(logging.INFO):
        response = make_client().get("/broken", headers={"x-request-id": "req-9"})

    assert response.status_code == 500
    assert response.json() == {"detail": "internal server error"}
    error = next(r for r in caplog.records if r.getMessage() == "unhandled exception")
    assert error.request_id == "req-9"
    assert "database unreachable" in str(error.exc_info[1])
    completed = next(r for r in caplog.records if r.getMessage() == "request completed")
    assert completed.status == 500
    assert completed.levelno == logging.ERROR


def test_request_id_is_visible_to_route_handlers():
    app = create_service("testsvc")

    @app.get("/whoami")
    async def whoami() -> dict[str, str | None]:
        return {"request_id": request_id_var.get()}

    client = TestClient(app)

    assert client.get("/whoami", headers={"x-request-id": "r-7"}).json() == {"request_id": "r-7"}
    assert request_id_var.get() is None


def test_health_and_metrics_are_not_counted_as_traffic(caplog):
    client = make_client()
    with caplog.at_level(logging.INFO):
        client.get("/health")
        client.get("/metrics")

    assert not [r for r in caplog.records if r.getMessage() == "request completed"]
    assert 'route="/health"' not in client.get("/metrics").text

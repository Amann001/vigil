"""Building blocks shared by every shop service: request metrics, request logging, health check."""

import logging
import time
import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager

import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

from shop.config import LOG_DIR, PORTS
from shop.jsonlog import configure_logging, request_id_var

REQUESTS = Counter(
    "http_requests_total",
    "HTTP requests handled.",
    ["service", "method", "route", "status"],
)
LATENCY = Histogram(
    "http_request_duration_seconds",
    "HTTP request latency.",
    ["service", "method", "route"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)
IN_PROGRESS = Gauge(
    "http_requests_in_progress",
    "HTTP requests currently being handled.",
    ["service"],
)

# Not recorded as traffic: Prometheus scrapes /metrics every few seconds and would drown
# real requests.
_UNTRACKED_PATHS = {"/metrics", "/health"}

Lifespan = Callable[[FastAPI], AbstractAsyncContextManager[None]]


def create_service(name: str, lifespan: Lifespan | None = None) -> FastAPI:
    """Create a FastAPI app with /health, /metrics and per-request metrics and logs."""
    app = FastAPI(title=f"shop-{name}", lifespan=lifespan)
    log = logging.getLogger(f"shop.{name}.http")

    @app.middleware("http")
    async def observe(request: Request, call_next):
        if request.url.path in _UNTRACKED_PATHS:
            return await call_next(request)

        # Reuse the caller's request ID so one request can be followed across services.
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
        request.state.request_id = request_id
        token = request_id_var.set(request_id)
        try:
            return await handle(request, call_next, request_id)
        finally:
            request_id_var.reset(token)

    async def handle(request: Request, call_next, request_id: str) -> Response:
        context = {"request_id": request_id, "method": request.method, "path": request.url.path}
        IN_PROGRESS.labels(name).inc()
        start = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            log.exception("unhandled exception", extra=context)
            response = JSONResponse({"detail": "internal server error"}, status_code=500)
        finally:
            IN_PROGRESS.labels(name).dec()
        duration = time.perf_counter() - start

        # The route template (/stock/{sku}) instead of the raw path keeps metric labels bounded.
        route = getattr(request.scope.get("route"), "path", "unmatched")
        REQUESTS.labels(name, request.method, route, str(response.status_code)).inc()
        LATENCY.labels(name, request.method, route).observe(duration)
        response.headers["x-request-id"] = request_id

        if response.status_code >= 500:
            level = logging.ERROR
        elif response.status_code >= 400:
            level = logging.WARNING
        else:
            level = logging.INFO
        log.log(
            level,
            "request completed",
            extra={
                **context,
                "route": route,
                "status": response.status_code,
                "duration_ms": round(duration * 1000, 2),
            },
        )
        return response

    @app.get("/health", include_in_schema=False)
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": name}

    @app.get("/metrics", include_in_schema=False)
    async def metrics() -> Response:
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    return app


def run(app: FastAPI, name: str) -> None:
    """Start a service on its configured port with JSON logging."""
    configure_logging(name, LOG_DIR)
    # log_config=None lets uvicorn's own logs flow through our JSON handlers.
    uvicorn.run(app, host="127.0.0.1", port=PORTS[name], log_config=None, access_log=False)

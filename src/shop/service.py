"""Building blocks shared by every shop service: request metrics, request logging, health check."""

import logging
import time
import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response
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
DEPENDENCY_CALLS = Counter(
    "dependency_calls_total",
    "Calls from one shop service to another.",
    ["service", "dependency", "outcome"],
)
DEPENDENCY_LATENCY = Histogram(
    "dependency_call_duration_seconds",
    "Latency of calls from one shop service to another.",
    ["service", "dependency"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0),
)

DEPENDENCY_TIMEOUT_SECONDS = 2.0

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


class Dependency:
    """HTTP client for calling another shop service.

    Propagates the current request ID, applies a timeout, records per-dependency metrics, and
    turns failures into the gateway errors a real service would return:
    504 if the dependency timed out, 503 if it was unreachable, 502 if it returned a 5xx.
    """

    def __init__(
        self, caller: str, name: str, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self.caller = caller
        self.name = name
        self.log = logging.getLogger(f"shop.{caller}.dependency")
        self.client = httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{PORTS[name]}",
            timeout=DEPENDENCY_TIMEOUT_SECONDS,
            transport=transport,
            event_hooks={"request": [self._propagate_request_id]},
        )

    @staticmethod
    async def _propagate_request_id(request: httpx.Request) -> None:
        if (request_id := request_id_var.get()) is not None:
            request.headers["x-request-id"] = request_id

    async def request(self, method: str, path: str, **kwargs) -> httpx.Response:
        """Send a request. Returns responses below 500; raises HTTPException otherwise."""
        context = {"dependency": self.name, "method": method, "path": path}
        start = time.perf_counter()
        try:
            response = await self.client.request(method, path, **kwargs)
        except httpx.TimeoutException:
            self._record("timeout", start)
            self.log.error("dependency timed out", extra=context)
            raise HTTPException(status_code=504, detail=f"{self.name} timed out") from None
        except httpx.TransportError as error:
            self._record("unreachable", start)
            self.log.error("dependency unreachable", extra={**context, "error": repr(error)})
            raise HTTPException(status_code=503, detail=f"{self.name} unavailable") from None

        if response.status_code >= 500:
            self._record("error", start)
            self.log.error(
                "dependency returned an error", extra={**context, "status": response.status_code}
            )
            raise HTTPException(status_code=502, detail=f"{self.name} failed")
        self._record("ok", start)
        return response

    def _record(self, outcome: str, start: float) -> None:
        DEPENDENCY_CALLS.labels(self.caller, self.name, outcome).inc()
        DEPENDENCY_LATENCY.labels(self.caller, self.name).observe(time.perf_counter() - start)

    async def aclose(self) -> None:
        await self.client.aclose()


def run(app: FastAPI, name: str) -> None:
    """Start a service on its configured port with JSON logging."""
    configure_logging(name, LOG_DIR)
    # log_config=None lets uvicorn's own logs flow through our JSON handlers.
    uvicorn.run(app, host="127.0.0.1", port=PORTS[name], log_config=None, access_log=False)

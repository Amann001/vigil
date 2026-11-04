"""Inventory service: tracks stock and reserves items for orders.

Run it with: uv run python -m shop.inventory
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from prometheus_client import Gauge
from pydantic import BaseModel, Field

from shop.service import create_service, run

NAME = "inventory"

INITIAL_STOCK = {
    "KEYBOARD-01": 600,
    "MOUSE-01": 1000,
    "MONITOR-27": 300,
    "HEADSET-01": 500,
    "WEBCAM-01": 400,
}

# A simulated warehouse delivery tops up items below half their initial level. Sized so that
# even ~8 checkouts/s never sells out between deliveries: in normal operation "out of stock"
# should be rare, so a sudden rise in it is a real anomaly rather than background noise.
RESTOCK_INTERVAL_SECONDS = 10
RESTOCK_THRESHOLD = 0.5

STOCK_LEVEL = Gauge("inventory_stock_level", "Units in stock per product.", ["sku"])

log = logging.getLogger("shop.inventory")


class StockChange(BaseModel):
    sku: str
    quantity: int = Field(gt=0, le=100)


def restock(stock: dict[str, int]) -> list[str]:
    """Refill every product below the threshold back to its initial level."""
    refilled = []
    for sku, initial in INITIAL_STOCK.items():
        if stock[sku] < initial * RESTOCK_THRESHOLD:
            log.info("restocked", extra={"sku": sku, "before": stock[sku], "after": initial})
            stock[sku] = initial
            STOCK_LEVEL.labels(sku).set(initial)
            refilled.append(sku)
    return refilled


def create_app() -> FastAPI:
    stock = dict(INITIAL_STOCK)
    for sku, units in stock.items():
        STOCK_LEVEL.labels(sku).set(units)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async def restock_forever() -> None:
            while True:
                await asyncio.sleep(RESTOCK_INTERVAL_SECONDS)
                restock(stock)

        task = asyncio.create_task(restock_forever())
        yield
        task.cancel()

    app = create_service(NAME, lifespan=lifespan)

    def available(sku: str) -> int:
        if sku not in stock:
            raise HTTPException(status_code=404, detail=f"unknown sku: {sku}")
        return stock[sku]

    def set_stock(sku: str, units: int) -> None:
        stock[sku] = units
        STOCK_LEVEL.labels(sku).set(units)

    @app.get("/stock")
    async def list_stock() -> dict[str, int]:
        return stock

    @app.get("/stock/{sku}")
    async def get_stock(sku: str) -> dict[str, str | int]:
        return {"sku": sku, "available": available(sku)}

    # No `await` between the check and the update, so concurrent requests can't oversell.
    @app.post("/reserve")
    async def reserve(change: StockChange) -> dict[str, str | int]:
        units = available(change.sku)
        if units < change.quantity:
            log.warning(
                "insufficient stock",
                extra={"sku": change.sku, "requested": change.quantity, "available": units},
            )
            raise HTTPException(status_code=409, detail="insufficient stock")
        set_stock(change.sku, units - change.quantity)
        log.info(
            "stock reserved",
            extra={"sku": change.sku, "quantity": change.quantity, "remaining": stock[change.sku]},
        )
        return {"sku": change.sku, "reserved": change.quantity, "remaining": stock[change.sku]}

    # Called by the orders service to undo a reservation when payment fails.
    @app.post("/release")
    async def release(change: StockChange) -> dict[str, str | int]:
        set_stock(change.sku, available(change.sku) + change.quantity)
        log.info(
            "stock released",
            extra={"sku": change.sku, "quantity": change.quantity, "remaining": stock[change.sku]},
        )
        return {"sku": change.sku, "released": change.quantity, "remaining": stock[change.sku]}

    return app


app = create_app()


def main() -> None:
    run(app, NAME)


if __name__ == "__main__":
    main()

"""Orders service: turns a checkout into reserved stock and a captured payment.

For each order it reserves every item with inventory, then charges payments. If anything
fails part-way, it releases whatever was already reserved so no stock is lost.

Run it with: uv run python -m shop.orders
"""

import logging
import uuid
from collections import OrderedDict
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from prometheus_client import Counter

from shop.catalog import PRODUCTS, OrderItem, OrderRequest
from shop.service import Dependency, create_service, run

NAME = "orders"

# Orders are kept in memory; the oldest are dropped so a long run can't exhaust RAM.
MAX_STORED_ORDERS = 1000

ORDERS = Counter("orders_total", "Orders by final status.", ["status", "reason"])

log = logging.getLogger("shop.orders")


class OrderFailed(Exception):
    def __init__(self, status_code: int, reason: str) -> None:
        self.status_code = status_code
        self.reason = reason


def create_app(inventory: Dependency | None = None, payments: Dependency | None = None) -> FastAPI:
    inventory = inventory or Dependency(NAME, "inventory")
    payments = payments or Dependency(NAME, "payments")
    orders: OrderedDict[str, dict] = OrderedDict()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        await inventory.aclose()
        await payments.aclose()

    app = create_service(NAME, lifespan=lifespan)

    def store(order: dict) -> None:
        orders[order["order_id"]] = order
        while len(orders) > MAX_STORED_ORDERS:
            orders.popitem(last=False)

    async def release(items: list[OrderItem], order_id: str) -> None:
        # Best effort: if inventory is down the stock stays reserved until a later fix.
        for item in items:
            try:
                await inventory.request("POST", "/release", json=item.model_dump())
            except HTTPException:
                log.error(
                    "could not release stock",
                    extra={"order_id": order_id, "sku": item.sku, "quantity": item.quantity},
                )

    @app.post("/orders", status_code=201)
    async def place_order(request: OrderRequest) -> dict:
        unknown = [item.sku for item in request.items if item.sku not in PRODUCTS]
        if unknown:
            raise HTTPException(status_code=400, detail=f"unknown sku: {', '.join(unknown)}")

        order_id = f"ord-{uuid.uuid4().hex[:12]}"
        total_cents = sum(PRODUCTS[i.sku]["price_cents"] * i.quantity for i in request.items)
        order = {
            "order_id": order_id,
            "items": [item.model_dump() for item in request.items],
            "total_cents": total_cents,
        }

        reserved: list[OrderItem] = []
        try:
            for item in request.items:
                response = await inventory.request("POST", "/reserve", json=item.model_dump())
                if response.status_code == 409:
                    raise OrderFailed(409, "out_of_stock")
                if response.status_code != 200:
                    raise OrderFailed(502, "inventory_rejected")
                reserved.append(item)

            response = await payments.request(
                "POST", "/charge", json={"order_id": order_id, "amount_cents": total_cents}
            )
            if response.status_code == 402:
                raise OrderFailed(402, "payment_declined")
            if response.status_code != 200:
                raise OrderFailed(502, "payments_rejected")
        except (OrderFailed, HTTPException) as error:
            await release(reserved, order_id)
            if isinstance(error, OrderFailed):
                status_code, reason = error.status_code, error.reason
            else:
                status_code, reason = error.status_code, "dependency_failure"
            store({**order, "status": "failed", "reason": reason})
            ORDERS.labels("failed", reason).inc()
            log.warning(
                "order failed",
                extra={"order_id": order_id, "reason": reason, "total_cents": total_cents},
            )
            raise HTTPException(
                status_code=status_code, detail={"order_id": order_id, "reason": reason}
            ) from None

        order = {**order, "status": "confirmed", "payment_id": response.json()["payment_id"]}
        store(order)
        ORDERS.labels("confirmed", "").inc()
        log.info("order confirmed", extra={"order_id": order_id, "total_cents": total_cents})
        return order

    @app.get("/orders/{order_id}")
    async def get_order(order_id: str) -> dict:
        if order_id not in orders:
            raise HTTPException(status_code=404, detail=f"unknown order: {order_id}")
        return orders[order_id]

    return app


app = create_app()


def main() -> None:
    run(app, NAME)


if __name__ == "__main__":
    main()

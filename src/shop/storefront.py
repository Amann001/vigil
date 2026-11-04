"""Storefront service: the shop's public API, used by customers.

Lists products with live availability and passes checkouts on to the orders service.

Run it with: uv run python -m shop.storefront
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from shop.catalog import PRODUCTS, OrderRequest
from shop.service import Dependency, create_service, run

NAME = "storefront"

log = logging.getLogger("shop.storefront")


def create_app(inventory: Dependency | None = None, orders: Dependency | None = None) -> FastAPI:
    inventory = inventory or Dependency(NAME, "inventory")
    orders = orders or Dependency(NAME, "orders")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        await inventory.aclose()
        await orders.aclose()

    app = create_service(NAME, lifespan=lifespan)

    @app.get("/products")
    async def list_products() -> list[dict]:
        # If inventory is down, still show the catalog, just without availability.
        try:
            stock = (await inventory.request("GET", "/stock")).json()
        except HTTPException:
            log.warning("showing products without availability")
            stock = {}
        return [
            {"sku": sku, **product, "available": stock.get(sku)}
            for sku, product in PRODUCTS.items()
        ]

    @app.post("/checkout")
    async def checkout(request: OrderRequest) -> JSONResponse:
        response = await orders.request("POST", "/orders", json=request.model_dump())
        return JSONResponse(response.json(), status_code=response.status_code)

    @app.get("/orders/{order_id}")
    async def get_order(order_id: str) -> JSONResponse:
        response = await orders.request("GET", f"/orders/{order_id}")
        return JSONResponse(response.json(), status_code=response.status_code)

    return app


app = create_app()


def main() -> None:
    run(app, NAME)


if __name__ == "__main__":
    main()

"""Payments service: charges customers for orders.

Simulates a card processor: each charge takes a little time and a small share are declined,
as in a real shop.

Run it with: uv run python -m shop.payments
"""

import asyncio
import logging
import random
import uuid

from fastapi import FastAPI, HTTPException
from prometheus_client import Counter
from pydantic import BaseModel, Field

from shop.service import create_service, run

NAME = "payments"

DECLINE_RATE = 0.03
LATENCY_SECONDS = (0.02, 0.08)

PAYMENTS = Counter("payments_total", "Payment attempts by outcome.", ["outcome"])
REVENUE = Counter("payments_captured_cents_total", "Money captured, in cents.")

log = logging.getLogger("shop.payments")


class Charge(BaseModel):
    order_id: str
    amount_cents: int = Field(gt=0)


def create_app(
    decline_rate: float = DECLINE_RATE,
    latency_seconds: tuple[float, float] = LATENCY_SECONDS,
    rng: random.Random | None = None,
) -> FastAPI:
    rng = rng or random.Random()
    app = create_service(NAME)

    @app.post("/charge")
    async def charge(request: Charge) -> dict[str, str | int]:
        await asyncio.sleep(rng.uniform(*latency_seconds))
        context = {"order_id": request.order_id, "amount_cents": request.amount_cents}

        if rng.random() < decline_rate:
            PAYMENTS.labels("declined").inc()
            log.warning("card declined", extra=context)
            raise HTTPException(status_code=402, detail="card declined")

        payment_id = f"pay-{uuid.uuid4().hex[:12]}"
        PAYMENTS.labels("captured").inc()
        REVENUE.inc(request.amount_cents)
        log.info("payment captured", extra={**context, "payment_id": payment_id})
        return {"payment_id": payment_id, "status": "captured", **context}

    return app


app = create_app()


def main() -> None:
    run(app, NAME)


if __name__ == "__main__":
    main()

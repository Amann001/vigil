"""Products sold by the demo shop, and the order request shape shared by services."""

from pydantic import BaseModel, Field

PRODUCTS = {
    "KEYBOARD-01": {"name": "Mechanical Keyboard", "price_cents": 8999},
    "MOUSE-01": {"name": "Wireless Mouse", "price_cents": 2999},
    "MONITOR-27": {"name": '27" 4K Monitor', "price_cents": 32999},
    "HEADSET-01": {"name": "Noise-Cancelling Headset", "price_cents": 14999},
    "WEBCAM-01": {"name": "1080p Webcam", "price_cents": 5999},
}


class OrderItem(BaseModel):
    sku: str
    quantity: int = Field(gt=0, le=10)


class OrderRequest(BaseModel):
    items: list[OrderItem] = Field(min_length=1, max_length=5)

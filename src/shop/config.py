"""Shared settings for the demo shop."""

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("VIGIL_DATA_DIR", PROJECT_ROOT / "data"))
LOG_DIR = DATA_DIR / "logs"

# One port per service. Every service binds to localhost only.
PORTS = {
    "storefront": 8000,
    "orders": 8001,
    "payments": 8002,
    "inventory": 8003,
}

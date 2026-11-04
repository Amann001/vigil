"""Structured JSON logging shared by every shop service.

Each log line is one JSON object, so Vigil's Logs agent can filter on fields
(service, level, request_id, ...) instead of parsing free text.
"""

import json
import logging
import sys
from datetime import UTC, datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path

# Attributes every LogRecord has. Anything else was passed with `extra=` and becomes a field.
_STANDARD_ATTRS = set(vars(logging.LogRecord("", 0, "", 0, "", None, None))) | {
    "message",
    "asctime",
}

# Keeps disk use bounded: at most 3 files x 5 MB per service.
_MAX_FILE_BYTES = 5_000_000
_BACKUP_COUNT = 2


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(
                timespec="milliseconds"
            ),
            "level": record.levelname,
            "service": self.service,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key, value in vars(record).items():
            if key not in _STANDARD_ATTRS and not key.startswith("_"):
                entry[key] = value
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


def configure_logging(service: str, log_dir: Path | None, level: int = logging.INFO) -> None:
    """Send all logs to stdout and, if `log_dir` is given, to a rotating file per service."""
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if log_dir is not None:
        log_dir.mkdir(parents=True, exist_ok=True)
        handlers.append(
            RotatingFileHandler(
                log_dir / f"{service}.log",
                maxBytes=_MAX_FILE_BYTES,
                backupCount=_BACKUP_COUNT,
                encoding="utf-8",
            )
        )

    formatter = JsonFormatter(service)
    root = logging.getLogger()
    root.handlers.clear()
    for handler in handlers:
        handler.setFormatter(formatter)
        root.addHandler(handler)
    root.setLevel(level)

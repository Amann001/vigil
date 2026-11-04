import json
import logging
import sys

from shop.jsonlog import JsonFormatter, configure_logging


def make_record(**extra) -> logging.LogRecord:
    record = logging.LogRecord(
        "shop.test", logging.WARNING, __file__, 1, "low stock: %s", ("KB",), None
    )
    record.__dict__.update(extra)
    return record


def test_formats_record_as_single_json_line():
    line = JsonFormatter("inventory").format(make_record())

    entry = json.loads(line)
    assert "\n" not in line
    assert entry["service"] == "inventory"
    assert entry["level"] == "WARNING"
    assert entry["logger"] == "shop.test"
    assert entry["message"] == "low stock: KB"
    assert entry["timestamp"].endswith("+00:00")


def test_extra_fields_become_top_level_keys():
    entry = json.loads(JsonFormatter("inventory").format(make_record(request_id="abc", status=409)))

    assert entry["request_id"] == "abc"
    assert entry["status"] == 409
    assert "args" not in entry
    assert "levelno" not in entry


def test_exception_traceback_is_included():
    try:
        raise ValueError("boom")
    except ValueError:
        record = make_record()
        record.exc_info = sys.exc_info()

    entry = json.loads(JsonFormatter("payments").format(record))

    assert "ValueError: boom" in entry["exception"]


def test_configure_logging_writes_json_to_service_file(tmp_path):
    root = logging.getLogger()
    saved_handlers, saved_level = root.handlers[:], root.level
    try:
        configure_logging("orders", tmp_path)
        logging.getLogger("shop.orders").info("order placed", extra={"order_id": "o-1"})
        for handler in root.handlers:
            handler.flush()

        entry = json.loads((tmp_path / "orders.log").read_text(encoding="utf-8").strip())
        assert entry["service"] == "orders"
        assert entry["order_id"] == "o-1"
    finally:
        for handler in root.handlers:
            handler.close()
        root.handlers[:] = saved_handlers
        root.setLevel(saved_level)

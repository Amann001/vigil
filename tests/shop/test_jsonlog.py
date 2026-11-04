import json
import logging
import sys

from shop.jsonlog import JsonFormatter, configure_logging, request_id_var


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


def test_uvicorn_colour_codes_are_dropped():
    entry = json.loads(
        JsonFormatter("orders").format(make_record(color_message="\x1b[36mStarted\x1b[0m"))
    )

    assert "color_message" not in entry


def test_current_request_id_is_added_to_every_line():
    formatter = JsonFormatter("inventory")
    token = request_id_var.set("req-42")
    try:
        inside = json.loads(formatter.format(make_record()))
    finally:
        request_id_var.reset(token)
    outside = json.loads(formatter.format(make_record()))

    assert inside["request_id"] == "req-42"
    assert "request_id" not in outside


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

        logging.getLogger("httpx").info('HTTP Request: GET http://x "HTTP/1.1 200 OK"')
        for handler in root.handlers:
            handler.flush()

        lines = (tmp_path / "orders.log").read_text(encoding="utf-8").splitlines()
        assert len(lines) == 1  # the httpx request line was suppressed
        entry = json.loads(lines[0])
        assert entry["service"] == "orders"
        assert entry["order_id"] == "o-1"
    finally:
        for handler in root.handlers:
            handler.close()
        root.handlers[:] = saved_handlers
        root.setLevel(saved_level)

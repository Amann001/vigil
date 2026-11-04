import json

import pandas as pd

from vigil.logevents import log_features, read_events, templates_seen


def write_log(path, lines):
    path.write_text("\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8")


def line(time: str, service: str, level: str, message: str, logger: str | None = None) -> dict:
    return {
        "timestamp": f"2026-11-04T12:00:{time}+00:00",
        "level": level,
        "service": service,
        "logger": logger or f"shop.{service}",
        "message": message,
    }


def test_reads_all_services_and_rotated_files_in_time_order(tmp_path):
    write_log(tmp_path / "orders.log", [line("07.000", "orders", "INFO", "order confirmed")])
    write_log(tmp_path / "orders.log.1", [line("01.000", "orders", "INFO", "order confirmed")])
    write_log(tmp_path / "payments.log", [line("04.000", "payments", "INFO", "payment captured")])

    events = read_events(tmp_path)

    assert list(events["service"]) == ["orders", "payments", "orders"]
    assert events["timestamp"].is_monotonic_increasing


def test_template_keys_ignore_parameters_but_keep_level_and_logger(tmp_path):
    write_log(
        tmp_path / "orders.log",
        [
            line("01.000", "orders", "INFO", "Started server process [111]", "uvicorn.error"),
            line("02.000", "orders", "INFO", "Started server process [222]", "uvicorn.error"),
            line("03.000", "orders", "WARNING", "order failed"),
        ],
    )

    templates = list(read_events(tmp_path)["template"])

    assert templates[0] == templates[1]
    assert templates[0].startswith("INFO uvicorn.error:")
    assert templates[2].startswith("WARNING shop.orders:")


def test_short_messages_differing_by_one_word_stay_distinct(tmp_path):
    write_log(
        tmp_path / "orders.log",
        [
            line("01.000", "orders", "INFO", "order confirmed"),
            line("02.000", "orders", "INFO", "order failed"),
            line("03.000", "orders", "INFO", "order exploded"),
            line("04.000", "orders", "INFO", "order confirmed"),
        ],
    )

    templates = list(read_events(tmp_path)["template"])

    assert len(set(templates)) == 3
    assert templates[0] == templates[3]


def test_empty_log_dir_gives_no_events(tmp_path):
    assert read_events(tmp_path).empty


def test_features_count_warnings_errors_and_new_templates(tmp_path):
    write_log(
        tmp_path / "inventory.log",
        [
            line("01.000", "inventory", "INFO", "stock reserved"),
            line("02.000", "inventory", "WARNING", "insufficient stock"),
            line("06.000", "inventory", "ERROR", "connection pool exhausted"),
            line("07.000", "inventory", "ERROR", "connection pool exhausted"),
        ],
    )
    events = read_events(tmp_path)
    index = pd.date_range("2026-11-04T12:00:00Z", periods=2, freq="5s")
    known = templates_seen(events, before=pd.Timestamp("2026-11-04T12:00:05Z"))

    features = log_features(events, index, known)

    first, second = features.iloc[0], features.iloc[1]
    assert first["inventory.log_warnings"] == 1
    assert first["inventory.log_new_templates"] == 0
    assert second["inventory.log_errors"] == 2
    assert second["inventory.log_new_templates"] == 2  # never seen during training
    assert features["orders.log_errors"].sum() == 0

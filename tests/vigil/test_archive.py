import json

import pytest

from vigil import archive as archive_module
from vigil.archive import Archive, restore, write_text


class FakeSession:
    """Stands in for the database: the tests never touch a real one."""

    def __init__(self):
        self.rows: dict[str, str] = {}

    def execute(self, query, params=None):
        if query.lstrip().startswith("INSERT"):
            path, body = params
            self.rows[path] = body
        return self

    def fetchall(self):
        return list(self.rows.items())


@pytest.fixture
def fake_archive(tmp_path, monkeypatch):
    store = Archive.__new__(Archive)
    store.root = tmp_path
    store.session = FakeSession()
    monkeypatch.setattr(archive_module, "_archive", store)
    monkeypatch.setattr(archive_module, "_checked", True)
    return store


def test_the_archive_is_off_unless_switched_on(monkeypatch):
    monkeypatch.setattr(archive_module, "_archive", None)
    monkeypatch.setattr(archive_module, "_checked", False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://example.invalid/db")
    monkeypatch.delenv("VIGIL_ARCHIVE", raising=False)

    assert archive_module.archive() is None


def test_a_written_file_is_kept_on_disk_and_in_the_archive(tmp_path, fake_archive):
    path = tmp_path / "investigations" / "live-1.json"

    write_text(path, json.dumps({"id": "live-1"}))

    assert json.loads(path.read_text(encoding="utf-8")) == {"id": "live-1"}
    assert fake_archive.session.rows == {"investigations/live-1.json": '{"id": "live-1"}'}
    assert not list(path.parent.glob("*.tmp"))


def test_a_fresh_host_gets_back_what_its_disk_lost(tmp_path, fake_archive):
    write_text(tmp_path / "investigations" / "live-1.json", "{}")
    write_text(tmp_path / "actions" / "audit.jsonl", '{"outcome": "executed"}\n')
    (tmp_path / "investigations" / "live-1.json").unlink()  # the host restarted
    (tmp_path / "actions" / "audit.jsonl").write_text("newer\n")  # a file still there stays

    assert restore() == 1
    assert (tmp_path / "investigations" / "live-1.json").read_text() == "{}"
    assert (tmp_path / "actions" / "audit.jsonl").read_text() == "newer\n"


def test_a_database_failure_does_not_lose_the_file(tmp_path, fake_archive):
    def broken(*args, **kwargs):
        raise OSError("connection lost")

    fake_archive.session.execute = broken
    path = tmp_path / "report.json"

    write_text(path, "{}")

    assert path.read_text() == "{}"

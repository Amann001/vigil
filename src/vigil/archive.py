"""A durable copy of Vigil's records in Postgres, for hosts whose disk does not last.

Reports, the timelines of running investigations and the audit log are files under DATA_DIR:
easy to read, diff and back up. A free cloud host wipes its disk at every restart, which would
lose every incident, so there each of those files is also written to a table, and `restore()`
puts them back when the host starts again.

Off unless VIGIL_ARCHIVE=1 and DATABASE_URL are both set (the cloud image sets them), so a
laptop run and the tests never touch the database through here.
"""

import contextlib
import logging
import os
from pathlib import Path

import psycopg

from shop.config import DATA_DIR

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS vigil_files (
    path text PRIMARY KEY,
    body text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
)
"""


class Archive:
    def __init__(self, url: str, root: Path = DATA_DIR) -> None:
        from vigil.db import Session

        self.root = root
        self.session = Session(url)
        # `vigil up` starts the API, the watcher and a worker at once; when two of them run
        # CREATE TABLE IF NOT EXISTS at the same moment, Postgres can fail the slower one even
        # so. The table it wanted exists, which is all that matters.
        with contextlib.suppress(psycopg.errors.UniqueViolation, psycopg.errors.DuplicateTable):
            self.session.execute(SCHEMA)

    def key(self, path: Path) -> str:
        return path.resolve().relative_to(self.root.resolve()).as_posix()

    def save(self, path: Path, body: str) -> None:
        self.session.execute(
            """
            INSERT INTO vigil_files (path, body) VALUES (%s, %s)
            ON CONFLICT (path) DO UPDATE SET body = excluded.body, updated_at = now()
            """,
            (self.key(path), body),
        )

    def restore(self) -> int:
        """Write back every archived file missing on disk; return how many."""
        restored = 0
        for key, body in self.session.execute("SELECT path, body FROM vigil_files").fetchall():
            path = self.root / key
            if path.exists():
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8")
            restored += 1
        return restored


_archive: Archive | None = None
_checked = False


def archive() -> Archive | None:
    """The archive when it is switched on, else None."""
    global _archive, _checked
    if not _checked:
        _checked = True
        url = os.environ.get("DATABASE_URL")
        if os.environ.get("VIGIL_ARCHIVE") == "1" and url:
            _archive = Archive(url)
    return _archive


def write_text(path: Path, body: str) -> None:
    """Write a file atomically (a reader never sees half of it), then archive it.

    A database hiccup is logged, not raised: the file on disk is the record that matters for
    the running system, and losing an investigation to a dropped connection would be worse.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(body, encoding="utf-8")
    os.replace(temporary, path)
    if (store := archive()) is not None:
        try:
            store.save(path, body)
        except Exception as error:  # noqa: BLE001 - any database failure is only logged
            log.warning("Could not archive %s: %s", path, error)


def restore() -> int:
    """Put back archived files missing on disk (at start-up on a fresh host)."""
    store = archive()
    return store.restore() if store is not None else 0

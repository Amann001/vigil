import psycopg
import pytest

from vigil import db


class FakeConnection:
    """Fails like a connection the server has closed: the statement errors, then closed is set."""

    def __init__(self, dropped: bool = False):
        self.dropped = dropped
        self.closed = False
        self.broken = False
        self.statements = []

    def execute(self, query, params=None):
        if self.dropped:
            self.closed = True
            raise psycopg.OperationalError("terminating connection due to administrator command")
        if query == "bad":
            raise psycopg.OperationalError("a real error in the statement")
        self.statements.append(query)
        return query

    def close(self):
        self.closed = True


@pytest.fixture
def connections(monkeypatch):
    made = [FakeConnection(dropped=True), FakeConnection()]
    opened = []

    def connect(url):
        opened.append(made[len(opened)])
        return opened[-1]

    monkeypatch.setattr(db, "connect", connect)
    return opened


def test_a_dropped_connection_is_replaced_and_the_statement_run_again(connections):
    hooks = []
    session = db.Session("postgresql://x", on_connect=hooks.append)

    result = session.execute("select 1")

    assert result == "select 1"
    assert len(connections) == 2 and connections[1].statements == ["select 1"]
    assert hooks == connections  # the new connection is set up like the first


def test_a_real_error_is_not_retried(monkeypatch):
    monkeypatch.setattr(db, "connect", lambda url: FakeConnection())
    session = db.Session("postgresql://x")

    with pytest.raises(psycopg.OperationalError, match="real error"):
        session.execute("bad")

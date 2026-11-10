"""Connecting to Postgres.

Neon offers two endpoints: a pooled one (host ending in -pooler, behind PgBouncer in
transaction mode) and a direct one. In transaction mode, server sessions are shared between
clients, so a session setting made by one client can leak to others: a test once set
search_path, and later connections could no longer find the pgvector type in `public`.
Vigil keeps a few long-lived connections, which is what the direct endpoint is for, so every
connection goes there.
"""

import psycopg

POOLED_MARKER = "-pooler."


def direct(url: str) -> str:
    """The direct endpoint for a Neon pooled URL; any other URL is returned unchanged."""
    return url.replace(POOLED_MARKER, ".", 1)


def connect(url: str) -> psycopg.Connection:
    return psycopg.connect(direct(url), autocommit=True)


class Session:
    """A long-lived connection that reconnects when the database has dropped it.

    Neon's free tier suspends an idle database and closes its connections, so a worker that
    waited a while for jobs crashed on its next statement. Statements run one at a time with
    autocommit, and a dropped connection fails a statement before it runs, so running it again
    on a new connection is safe.
    """

    def __init__(self, url: str, on_connect=None) -> None:
        self.url = url
        self.on_connect = on_connect
        self.connection = self._connect()

    def _connect(self) -> psycopg.Connection:
        connection = connect(self.url)
        if self.on_connect is not None:
            self.on_connect(connection)
        return connection

    def ensure(self) -> psycopg.Connection:
        """The connection, replaced first if it has been closed."""
        if self.connection.closed or self.connection.broken:
            self.connection = self._connect()
        return self.connection

    def execute(self, query, params=None) -> psycopg.Cursor:
        try:
            return self.ensure().execute(query, params)
        except psycopg.OperationalError:
            if not (self.connection.closed or self.connection.broken):
                raise  # a real error in the statement, not a lost connection
            return self.ensure().execute(query, params)

    def close(self) -> None:
        self.connection.close()

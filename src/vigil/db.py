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

"""A durable job queue in Postgres, so investigations survive a worker crashing.

The watcher enqueues a job per alert; workers claim jobs and run them. How it stays correct:
- Claiming uses `FOR UPDATE SKIP LOCKED`: concurrent workers skip rows another worker is
  claiming, so two workers never run the same job, and nobody waits on a lock.
- A claimed job has a lease. A running worker renews it (a heartbeat); if the worker dies,
  the lease runs out and another worker reclaims the job. The investigation then continues
  from its last checkpoint instead of starting over.
- A job that fails is retried with exponential backoff, up to max_attempts; after that it is
  marked failed with its last error, for a human to look at (a "dead letter").
- An optional key makes enqueueing idempotent: the same alert is never queued twice.

All times come from the database's clock, so workers on different machines agree.
"""

import re
from dataclasses import dataclass

from psycopg.types.json import Jsonb

from vigil.db import connect

LEASE_SECONDS = 60
BACKOFF_SECONDS = 30  # doubled after each failed attempt
MAX_ATTEMPTS = 3
SCHEMA = """
create table if not exists {table} (
    id bigserial primary key,
    kind text not null,
    key text unique,
    payload jsonb not null,
    status text not null default 'queued'
        check (status in ('queued', 'running', 'done', 'failed')),
    attempts integer not null default 0,
    max_attempts integer not null default 3,
    run_after timestamptz not null default now(),
    locked_by text,
    lease_until timestamptz,
    last_error text,
    result jsonb,
    created_at timestamptz not null default now(),
    finished_at timestamptz
);
create index if not exists jobs_ready_idx on {table} (run_after)
    where status in ('queued', 'running');
"""


@dataclass(frozen=True)
class Job:
    id: int
    kind: str
    payload: dict
    attempts: int
    max_attempts: int


class Queue:
    def __init__(self, url: str, schema: str | None = None) -> None:
        self.connection = connect(url)
        # Table names are qualified with the schema rather than set via search_path: session
        # settings leak between clients behind a transaction-mode pooler (see vigil.db).
        self.table = "jobs"
        if schema is not None:
            if not re.fullmatch(r"[a-z_][a-z0-9_]*", schema):
                raise ValueError(f"unsafe schema name {schema!r}")
            self.connection.execute(f"create schema if not exists {schema}")
            self.table = f"{schema}.jobs"
        self.connection.execute(SCHEMA.format(table=self.table))

    def close(self) -> None:
        self.connection.close()

    def enqueue(
        self, kind: str, payload: dict, key: str | None = None, max_attempts: int = MAX_ATTEMPTS
    ) -> int | None:
        """Add a job; returns its id, or None if a job with this key already exists."""
        row = self.connection.execute(
            f"""insert into {self.table} (kind, key, payload, max_attempts) values (%s, %s, %s, %s)
               on conflict (key) do nothing returning id""",
            (kind, key, Jsonb(payload), max_attempts),
        ).fetchone()
        return row[0] if row else None

    def claim(self, worker: str, lease_seconds: float = LEASE_SECONDS) -> Job | None:
        """Take the next job that is ready, or whose worker stopped renewing its lease."""
        row = self.connection.execute(
            f"""
            update {self.table} set status = 'running', locked_by = %(worker)s,
                lease_until = now() + make_interval(secs => %(lease)s),
                attempts = attempts + 1
            where id = (
                select id from {self.table}
                where (status = 'queued' and run_after <= now())
                   or (status = 'running' and lease_until < now())
                order by run_after, id
                for update skip locked
                limit 1
            )
            returning id, kind, payload, attempts, max_attempts
            """,
            {"worker": worker, "lease": lease_seconds},
        ).fetchone()
        if row is None:
            return None
        job = Job(*row)
        if job.attempts > job.max_attempts:
            # Reclaimed after its worker died on the last allowed attempt: give up on it.
            self._finish(job.id, worker, "failed", error="worker stopped on the last attempt")
            return self.claim(worker, lease_seconds)
        return job

    def heartbeat(self, job: Job, worker: str, lease_seconds: float = LEASE_SECONDS) -> bool:
        """Renew the lease; False means this worker no longer holds the job."""
        cursor = self.connection.execute(
            f"""update {self.table} set lease_until = now() + make_interval(secs => %s)
               where id = %s and locked_by = %s and status = 'running'""",
            (lease_seconds, job.id, worker),
        )
        return cursor.rowcount == 1

    def complete(self, job: Job, worker: str, result: dict | None = None) -> bool:
        return self._finish(job.id, worker, "done", result=result)

    def fail(self, job: Job, worker: str, error: str) -> str:
        """Retry later with backoff, or mark failed after the last attempt. Returns the status."""
        if job.attempts >= job.max_attempts:
            self._finish(job.id, worker, "failed", error=error)
            return "failed"
        delay = BACKOFF_SECONDS * 2 ** (job.attempts - 1)
        self.connection.execute(
            f"""update {self.table} set status = 'queued', locked_by = null, lease_until = null,
                   last_error = %s, run_after = now() + make_interval(secs => %s)
               where id = %s and locked_by = %s""",
            (error, delay, job.id, worker),
        )
        return "queued"

    def _finish(self, job_id: int, worker: str, status: str, result=None, error=None) -> bool:
        cursor = self.connection.execute(
            f"""update {self.table} set status = %s, result = %s,
                   last_error = coalesce(%s, last_error), finished_at = now(), lease_until = null
               where id = %s and locked_by = %s""",
            (status, Jsonb(result) if result is not None else None, error, job_id, worker),
        )
        return cursor.rowcount == 1

    def jobs(self, limit: int = 50) -> list[dict]:
        rows = self.connection.execute(
            f"""select id, kind, key, status, attempts, max_attempts, locked_by, last_error,
                      created_at, finished_at
               from {self.table} order by id desc limit %s""",
            (limit,),
        )
        names = [c.name for c in rows.description]
        return [dict(zip(names, row, strict=True)) for row in rows.fetchall()]

    def counts(self) -> dict[str, int]:
        rows = self.connection.execute(f"select status, count(*) from {self.table} group by status")
        return dict(rows.fetchall())

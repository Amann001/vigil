"""Vigil's memory: runbooks and past incidents, retrieved by meaning.

Four ways of searching are implemented and measured (vigil.memory_eval):
- keyword: Postgres full-text search, for exact terms such as "connection pool exhausted";
- vector: pgvector similarity of BAAI/bge-small-en-v1.5 embeddings, for the same meaning in
  different words ("memory climbing then the process died" ~ "memory leak");
- hybrid: both rankings merged with reciprocal rank fusion;
- hybrid+rerank: the fused candidates re-scored by a cross-encoder (ms-marco MiniLM).
Vector search is the default because it measured best: searching with a diagnosis, it put the
right runbook first 11 times out of 11, against 9 for hybrid with reranking.

Memory respects time: a search can be limited to incidents that happened before a moment, so a
replayed investigation only remembers incidents that came before it.

Documents live in Postgres when DATABASE_URL is set (Neon), otherwise in a local in-process
store used by the tests.
"""

import json
import math
import re
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Protocol

import numpy as np
import pandas as pd

from shop.config import DATA_DIR, PROJECT_ROOT

RUNBOOK_DIR = PROJECT_ROOT / "runbooks"
MODEL_DIR = DATA_DIR / "models" / "fastembed"
EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"
RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2"
DIMENSIONS = 384
CANDIDATES = 20  # taken from each retriever before fusion
RRF_K = 60  # the usual constant in reciprocal rank fusion: damps the weight of the top ranks
RERANK_CANDIDATES = 10
Kind = Literal["runbook", "incident"]
Mode = Literal["keyword", "vector", "hybrid", "hybrid+rerank"]
WORD = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True)
class Document:
    id: str
    kind: Kind
    title: str
    body: str
    occurred_at: pd.Timestamp | None = None
    metadata: dict = field(default_factory=dict)

    @property
    def text(self) -> str:
        return f"{self.title}\n{self.body}"


@dataclass(frozen=True)
class Hit:
    document: Document
    score: float


class Encoder:
    """The two models, loaded on first use (each takes a few seconds)."""

    def __init__(self, cache_dir: Path = MODEL_DIR) -> None:
        self.cache_dir = cache_dir
        self._embedder = self._reranker = None

    def embed(self, texts: Sequence[str]) -> np.ndarray:
        if self._embedder is None:
            from fastembed import TextEmbedding

            self._embedder = TextEmbedding(EMBEDDING_MODEL, cache_dir=str(self.cache_dir))
        return np.array(list(self._embedder.embed(list(texts))), dtype=np.float32)

    def rerank(self, query: str, texts: Sequence[str]) -> list[float]:
        if self._reranker is None:
            from fastembed.rerank.cross_encoder import TextCrossEncoder

            self._reranker = TextCrossEncoder(RERANK_MODEL, cache_dir=str(self.cache_dir))
        return [float(s) for s in self._reranker.rerank(query, list(texts))]


class Store(Protocol):
    def upsert(self, documents: Sequence[Document], vectors: np.ndarray) -> None: ...

    def vector_search(
        self, vector: np.ndarray, kinds: Sequence[str], before, exclude: str | None, limit: int
    ) -> list[Document]: ...

    def keyword_search(
        self, words: list[str], kinds: Sequence[str], before, exclude: str | None, limit: int
    ) -> list[Document]: ...

    def count(self) -> dict[str, int]: ...


def _visible(document: Document, kinds, before, exclude) -> bool:
    if document.kind not in kinds or document.id == exclude:
        return False
    return before is None or document.occurred_at is None or document.occurred_at < before


class LocalStore:
    """In-process store: exact cosine similarity and BM25 keyword scoring."""

    def __init__(self) -> None:
        self.documents: dict[str, Document] = {}
        self.vectors: dict[str, np.ndarray] = {}

    def upsert(self, documents: Sequence[Document], vectors: np.ndarray) -> None:
        for document, vector in zip(documents, vectors, strict=True):
            self.documents[document.id] = document
            self.vectors[document.id] = vector / (np.linalg.norm(vector) or 1.0)

    def _candidates(self, kinds, before, exclude) -> list[Document]:
        return [d for d in self.documents.values() if _visible(d, kinds, before, exclude)]

    def vector_search(self, vector, kinds, before, exclude, limit) -> list[Document]:
        query = vector / (np.linalg.norm(vector) or 1.0)
        found = self._candidates(kinds, before, exclude)
        return sorted(found, key=lambda d: -float(self.vectors[d.id] @ query))[:limit]

    def keyword_search(self, words, kinds, before, exclude, limit) -> list[Document]:
        found = self._candidates(kinds, before, exclude)
        tokens = {d.id: WORD.findall(d.text.lower()) for d in found}
        average = sum(len(t) for t in tokens.values()) / max(len(tokens), 1)
        frequency = Counter(w for t in tokens.values() for w in set(t))

        def bm25(document: Document) -> float:
            counts, length, score = Counter(tokens[document.id]), len(tokens[document.id]), 0.0
            for word in set(words):
                if counts[word]:
                    idf = math.log(
                        1 + (len(found) - frequency[word] + 0.5) / (frequency[word] + 0.5)
                    )
                    score += (
                        idf
                        * counts[word]
                        * 2.2
                        / (counts[word] + 1.2 * (0.25 + 0.75 * length / average))
                    )
            return score

        scored = [(bm25(d), d) for d in found]
        return [d for s, d in sorted(scored, key=lambda p: -p[0]) if s > 0][:limit]

    def count(self) -> dict[str, int]:
        return dict(Counter(d.kind for d in self.documents.values()))


SCHEMA = """
create extension if not exists vector;
create table if not exists {table} (
    id text primary key,
    kind text not null,
    title text not null,
    body text not null,
    occurred_at timestamptz,
    metadata jsonb not null default '{{}}',
    embedding vector({dimensions}) not null,
    search tsvector generated always as (to_tsvector('english', title || ' ' || body)) stored
);
create index if not exists memory_search_idx on {table} using gin (search);
"""
# No vector index: with hundreds of documents an exact scan is fast and never misses a match.
# An HNSW index (`using hnsw (embedding vector_cosine_ops)`) is the step for many thousands.


class PostgresStore:
    """pgvector for similarity, Postgres full-text search for keywords."""

    def __init__(self, url: str, schema: str | None = None) -> None:
        from pgvector.psycopg import register_vector

        from vigil.db import Session

        self.session = Session(url)
        # Qualified table names, not search_path: see the note in vigil.queue.
        self.table = "memory"
        if schema is not None:
            if not re.fullmatch(r"[a-z_][a-z0-9_]*", schema):
                raise ValueError(f"unsafe schema name {schema!r}")
            self.session.execute(f"create schema if not exists {schema}")
            self.table = f"{schema}.memory"
        self.session.execute(SCHEMA.format(table=self.table, dimensions=DIMENSIONS))
        # The vector type exists only once the schema has created the extension; from now on
        # every new connection (after a reconnect too) learns it.
        self.session.on_connect = register_vector
        register_vector(self.session.connection)

    def upsert(self, documents: Sequence[Document], vectors: np.ndarray) -> None:
        with self.session.ensure().cursor() as cursor:
            for document, vector in zip(documents, vectors, strict=True):
                cursor.execute(
                    f"""
                    insert into {self.table}
                        (id, kind, title, body, occurred_at, metadata, embedding)
                    values (%s, %s, %s, %s, %s, %s, %s)
                    on conflict (id) do update set kind = excluded.kind, title = excluded.title,
                        body = excluded.body, occurred_at = excluded.occurred_at,
                        metadata = excluded.metadata, embedding = excluded.embedding
                    """,
                    (
                        document.id,
                        document.kind,
                        document.title,
                        document.body,
                        document.occurred_at.to_pydatetime() if document.occurred_at else None,
                        json.dumps(document.metadata),
                        vector,
                    ),
                )

    _FILTER = """kind = any(%(kinds)s) and id <> %(exclude)s
        and (occurred_at is null or %(before)s::timestamptz is null
             or occurred_at < %(before)s::timestamptz)"""
    _COLUMNS = "id, kind, title, body, occurred_at, metadata"

    def _rows(self, sql: str, params: dict) -> list[Document]:
        rows = self.session.execute(sql, params).fetchall()
        return [
            Document(i, k, t, b, pd.Timestamp(o) if o else None, m or {})
            for i, k, t, b, o, m in rows
        ]

    def _params(self, kinds, before, exclude, limit) -> dict:
        when = before.to_pydatetime() if before is not None else None
        return {"kinds": list(kinds), "before": when, "exclude": exclude or "", "limit": limit}

    def vector_search(self, vector, kinds, before, exclude, limit) -> list[Document]:
        params = self._params(kinds, before, exclude, limit) | {"vector": vector}
        sql = f"""select {self._COLUMNS} from {self.table} where {self._FILTER}
                  order by embedding <=> %(vector)s limit %(limit)s"""
        return self._rows(sql, params)

    def keyword_search(self, words, kinds, before, exclude, limit) -> list[Document]:
        if not words:
            return []
        # Any of the words may match ("a | b | c"); ranking rewards documents matching more.
        params = self._params(kinds, before, exclude, limit) | {"query": " | ".join(words)}
        sql = f"""select {self._COLUMNS} from {self.table},
                         to_tsquery('english', %(query)s) as query
                  where search @@ query and {self._FILTER}
                  order by ts_rank_cd(search, query) desc limit %(limit)s"""
        return self._rows(sql, params)

    def count(self) -> dict[str, int]:
        rows = self.session.execute(f"select kind, count(*) from {self.table} group by kind")
        return dict(rows.fetchall())


def reciprocal_rank_fusion(rankings: Sequence[Sequence[Document]]) -> list[tuple[Document, float]]:
    """Merge rankings: each document scores the sum of 1 / (RRF_K + rank) over the rankings.

    Only ranks are used, so a keyword score and a cosine similarity, which are on different
    scales, never have to be compared directly."""
    scores: dict[str, float] = {}
    documents: dict[str, Document] = {}
    for ranking in rankings:
        for rank, document in enumerate(ranking, start=1):
            scores[document.id] = scores.get(document.id, 0.0) + 1.0 / (RRF_K + rank)
            documents[document.id] = document
    return sorted(((documents[i], s) for i, s in scores.items()), key=lambda p: -p[1])


class Memory:
    def __init__(self, store: Store, embed: Callable, rerank: Callable) -> None:
        self.store = store
        self.embed = embed
        self.rerank = rerank

    def add(self, documents: Sequence[Document]) -> None:
        if documents:
            self.store.upsert(documents, self.embed([d.text for d in documents]))

    def search(
        self,
        query: str,
        kinds: Sequence[Kind] = ("runbook", "incident"),
        before: pd.Timestamp | None = None,
        exclude: str | None = None,
        limit: int = 3,
        mode: Mode = "vector",
    ) -> list[Hit]:
        words = sorted(set(WORD.findall(query.lower())))
        keyword = vector = []
        if mode != "vector":
            keyword = self.store.keyword_search(words, kinds, before, exclude, CANDIDATES)
        if mode != "keyword":
            query_vector = self.embed([query])[0]
            vector = self.store.vector_search(query_vector, kinds, before, exclude, CANDIDATES)
        if mode == "keyword":
            return [Hit(d, 1.0 / rank) for rank, d in enumerate(keyword[:limit], start=1)]
        if mode == "vector":
            return [Hit(d, 1.0 / rank) for rank, d in enumerate(vector[:limit], start=1)]
        fused = reciprocal_rank_fusion([keyword, vector])
        if mode == "hybrid":
            return [Hit(d, s) for d, s in fused[:limit]]
        top = [d for d, _ in fused[:RERANK_CANDIDATES]]
        if not top:
            return []
        scores = self.rerank(query, [d.text for d in top])
        ranked = sorted(zip(top, scores, strict=True), key=lambda p: -p[1])
        return [Hit(d, s) for d, s in ranked[:limit]]


def load_runbooks(directory: Path = RUNBOOK_DIR) -> list[Document]:
    documents = []
    for path in sorted(directory.glob("*.md")):
        text = path.read_text(encoding="utf-8").strip()
        title, _, body = text.partition("\n")
        documents.append(Document(path.stem, "runbook", title.lstrip("# ").strip(), body.strip()))
    return documents


def incident_document(report: dict) -> Document:
    """A reviewed investigation as a past incident: what happened, the human's verdict, and the
    action taken. Corrections take precedence over the agents' diagnosis."""
    diagnosis, review = report["diagnosis"], report.get("review", {})
    lines = [diagnosis["summary"], "Evidence:", *(f"- {e}" for e in diagnosis["evidence"])]
    if review.get("verdict") == "corrected":
        lines.append(f"Correction by the reviewer: {review.get('notes', '')}")
    if action := report.get("action"):
        lines.append(f"Action: {action.get('action')} {action.get('service') or ''}".rstrip())
        lines.append(f"Outcome: {action.get('outcome')}")
    title = (
        f"Incident {report['id']}: {diagnosis['root_cause_service']} "
        f"{diagnosis['category'].replace('_', ' ')}"
    )
    return Document(
        report["id"],
        "incident",
        title,
        "\n".join(lines),
        pd.Timestamp(report["alert_at"]),
        {"verdict": review.get("verdict"), "diagnosis": diagnosis},
    )


def open_memory(url: str | None) -> Memory:
    """Memory backed by Postgres if a URL is given, else a local store; real models either way."""
    encoder = Encoder()
    store: Store = PostgresStore(url) if url else LocalStore()
    return Memory(store, encoder.embed, encoder.rerank)

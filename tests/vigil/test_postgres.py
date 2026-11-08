"""The Postgres code paths (pgvector, full-text search, checkpoints) against a real database.

Skipped unless VIGIL_TEST_DATABASE_URL is set. Memory tests use their own schema, dropped
afterwards; the checkpoint test uses its own investigation id and deletes it.
"""

import os
import uuid
import zlib

import numpy as np
import pandas as pd
import pytest

from vigil.alerts import Alert, Signal
from vigil.db import connect
from vigil.memory import DIMENSIONS, WORD, Document, Memory, PostgresStore

URL = os.environ.get("VIGIL_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="set VIGIL_TEST_DATABASE_URL to run these")


def bag_of_words(texts):
    vectors = np.zeros((len(texts), DIMENSIONS), dtype=np.float32)
    for row, text in enumerate(texts):
        for word in WORD.findall(text.lower()):
            vectors[row, zlib.crc32(word.encode()) % DIMENSIONS] += 1
    return vectors


@pytest.fixture
def memory():
    schema = f"test_{uuid.uuid4().hex[:12]}"
    store = PostgresStore(URL, schema)
    yield Memory(store, bag_of_words, lambda query, texts: [0.0] * len(texts))
    store.connection.close()
    with connect(URL) as connection:
        connection.execute(f"drop schema if exists {schema} cascade")


DOCUMENTS = [
    Document("memory-leak", "runbook", "Memory leak", "memory grows until the process is killed"),
    Document("error-spike", "runbook", "Error spike", "connection pool exhausted, status 500"),
    Document(
        "old", "incident", "payments crash", "payments stopped", pd.Timestamp("2026-11-01T00:00Z")
    ),
    Document(
        "new", "incident", "payments crash", "payments stopped", pd.Timestamp("2026-11-09T00:00Z")
    ),
]


def test_vector_and_keyword_search_in_postgres(memory):
    memory.add(DOCUMENTS)

    by_meaning = memory.search("memory grows then killed", kinds=["runbook"], mode="vector")
    by_words = memory.search("connection pool exhausted", kinds=["runbook"], mode="keyword")

    assert by_meaning[0].document.id == "memory-leak"
    assert by_words[0].document.id == "error-spike"
    assert memory.store.count() == {"runbook": 2, "incident": 2}


def test_postgres_remembers_only_earlier_incidents_and_never_the_current_one(memory):
    memory.add(DOCUMENTS)
    before = pd.Timestamp("2026-11-05T00:00Z")

    found = memory.search("payments crash", kinds=["incident"], before=before, mode="hybrid")
    itself = memory.search("payments crash", kinds=["incident"], exclude="old", before=before)

    assert [hit.document.id for hit in found] == ["old"]
    assert itself == []


def test_upserting_a_document_replaces_it(memory):
    memory.add(DOCUMENTS[:1])
    memory.add([Document("memory-leak", "runbook", "Memory leak", "rewritten")])

    (hit,) = memory.search("rewritten", kinds=["runbook"], mode="keyword")

    assert hit.document.body == "rewritten" and memory.store.count() == {"runbook": 1}


def test_checkpoints_in_postgres_survive_a_new_connection(monkeypatch, tmp_path):
    from typing import TypedDict

    from langgraph.graph import END, START, StateGraph
    from langgraph.types import interrupt

    from vigil import investigations

    class State(TypedDict, total=False):
        alert: str
        diagnosis: dict
        models: list
        review: dict

    def graph_without_models(checkpointer=None):
        graph = StateGraph(State)
        graph.add_node("diagnose", lambda s: {"diagnosis": {"root_cause_service": "payments"}})
        graph.add_node("review", lambda s: {"review": interrupt(s["diagnosis"])})
        graph.add_edge(START, "diagnose")
        graph.add_edge("diagnose", "review")
        graph.add_edge("review", END)
        return graph.compile(checkpointer=checkpointer)

    monkeypatch.setattr(investigations, "build_graph", graph_without_models)
    identifier = f"test-{uuid.uuid4().hex[:12]}"
    alert = Alert(pd.Timestamp("2026-11-08T12:00:00Z"), (Signal("payments.up", 0, 1, 1000),))
    paths = {"store": URL, "reports_dir": tmp_path}
    try:
        investigations.investigate(identifier, alert, evidence=None, **paths)
        report = investigations.review(identifier, "confirmed", **paths)  # a new connection
        assert report["status"] == "confirmed"
    finally:
        with investigations.open_graph(URL) as graph:
            graph.checkpointer.delete_thread(identifier)

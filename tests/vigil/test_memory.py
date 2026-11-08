import zlib

import numpy as np
import pandas as pd
import pytest

from vigil.memory import (
    RRF_K,
    WORD,
    Document,
    LocalStore,
    Memory,
    incident_document,
    load_runbooks,
    reciprocal_rank_fusion,
)

DIMENSIONS = 64


def bag_of_words(texts):
    """A stand-in embedding: words hashed into a fixed-size vector."""
    vectors = np.zeros((len(texts), DIMENSIONS), dtype=np.float32)
    for row, text in enumerate(texts):
        for word in WORD.findall(text.lower()):
            vectors[row, zlib.crc32(word.encode()) % DIMENSIONS] += 1
    return vectors


def prefer(word):
    """A stand-in reranker that scores documents by how often they mention `word`."""
    return lambda query, texts: [float(t.lower().count(word)) for t in texts]


LEAK = Document("memory-leak", "runbook", "Memory leak", "memory grows until the process is killed")
DOWN = Document("service-down", "runbook", "Service down", "the process stopped; callers fail")
POOL = Document("error-spike", "runbook", "Error spike", "connection pool exhausted, status 500")


def incident(identifier: str, when: str) -> Document:
    return Document(
        identifier, "incident", "payments crash", "payments stopped", pd.Timestamp(when)
    )


@pytest.fixture
def memory() -> Memory:
    memory = Memory(LocalStore(), bag_of_words, prefer("memory"))
    memory.add([LEAK, DOWN, POOL])
    return memory


def test_fusion_rewards_documents_both_retrievers_found():
    fused = reciprocal_rank_fusion([[LEAK, POOL], [POOL, DOWN]])

    # POOL was found by both: second in one ranking and first in the other beats first in one.
    assert [d.id for d, _ in fused] == ["error-spike", "memory-leak", "service-down"]
    assert fused[0][1] == pytest.approx(1 / (RRF_K + 2) + 1 / (RRF_K + 1))


def test_keyword_search_finds_exact_terms(memory):
    hits = memory.search("connection pool exhausted", mode="keyword", limit=1)

    assert hits[0].document.id == "error-spike"


def test_vector_search_finds_similar_wording(memory):
    hits = memory.search("memory grows, then killed", mode="vector", limit=1)

    assert hits[0].document.id == "memory-leak"


def test_reranking_reorders_the_fused_candidates():
    memory = Memory(LocalStore(), bag_of_words, prefer("callers"))
    memory.add([LEAK, DOWN, POOL])

    hits = memory.search("the process", mode="hybrid+rerank", limit=1)

    assert hits[0].document.id == "service-down"


def test_only_incidents_before_the_moment_are_remembered(memory):
    memory.add([incident("past", "2026-11-04T16:00:00Z"), incident("future", "2026-11-04T18:00Z")])

    hits = memory.search(
        "payments crash", kinds=["incident"], before=pd.Timestamp("2026-11-04T17:00:00Z")
    )

    assert [h.document.id for h in hits] == ["past"]


def test_an_investigation_never_retrieves_itself(memory):
    memory.add([incident("this-one", "2026-11-04T16:00:00Z")])

    assert memory.search("payments crash", kinds=["incident"], exclude="this-one") == []


def test_runbooks_are_loaded_with_their_titles():
    runbooks = {d.id: d for d in load_runbooks()}

    assert {"memory-leak", "service-down", "cascading-failure", "normal-variation"} <= set(runbooks)
    assert runbooks["memory-leak"].title == "Memory leak"
    assert all(d.kind == "runbook" and "## Fix" in d.body for d in runbooks.values())


def test_a_corrected_incident_is_remembered_with_the_correction():
    report = {
        "id": "live-1",
        "alert_at": "2026-11-08T06:00:45+00:00",
        "diagnosis": {
            "root_cause_service": "orders",
            "category": "service_crash",
            "summary": "orders crashed",
            "evidence": ["orders.up = 0"],
        },
        "review": {"verdict": "corrected", "notes": "it was a memory leak"},
        "action": {"action": "restart_service", "service": "orders", "outcome": "executed"},
    }

    document = incident_document(report)

    assert document.kind == "incident" and document.occurred_at == pd.Timestamp(report["alert_at"])
    assert "Correction by the reviewer: it was a memory leak" in document.body
    assert "Action: restart_service orders" in document.body

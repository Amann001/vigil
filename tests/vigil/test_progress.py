import json
from typing import Annotated, TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from vigil.progress import Timeline, event, follow

FINDING = {
    "agent": "metrics",
    "question": "Is payments slow?",
    "report": "p95 is 2.3 s",
    "tool_calls": [{"name": "service_overview", "args": {}}, {"name": "metric_history"}],
    "models": ["groq"],
}


def test_each_step_becomes_an_event_with_what_it_produced():
    plan = event("plan", {"round": 1, "tasks": [{"agent": "metrics", "question": "?"}]})
    finding = event("specialist", {"findings": [FINDING]})
    paused = event("__interrupt__", None)

    assert plan["round"] == 1 and plan["tasks"][0]["agent"] == "metrics"
    assert finding["agent"] == "metrics"
    assert finding["tools"] == ["service_overview", "metric_history"]
    assert paused["step"] == "review"
    assert event("remember", {}) is None  # nothing worth showing


def test_the_timeline_file_always_holds_every_event_so_far(tmp_path):
    path = tmp_path / "live" / "x.json"
    timeline = Timeline(path, {"id": "x"})

    timeline.add("diagnose", {"diagnosis": {"root_cause_service": "payments"}})
    on_disk = json.loads(path.read_text())
    timeline.finish("awaiting review")
    finished = json.loads(path.read_text())

    assert on_disk["status"] == "investigating" and len(on_disk["events"]) == 1
    assert finished["status"] == "awaiting review"
    assert not list(path.parent.glob("*.tmp"))


class State(TypedDict, total=False):
    findings: Annotated[list, lambda a, b: a + b]
    diagnosis: dict
    review: dict


def small_graph():
    graph = StateGraph(State)
    graph.add_node("specialist", lambda s: {"findings": [FINDING]})
    graph.add_node("diagnose", lambda s: {"diagnosis": {"root_cause_service": "payments"}})
    graph.add_node("review", lambda s: {"review": interrupt("approve?")})
    graph.add_edge(START, "specialist")
    graph.add_edge("specialist", "diagnose")
    graph.add_edge("diagnose", "review")
    graph.add_edge("review", END)
    return graph.compile(checkpointer=InMemorySaver())


def test_following_a_graph_records_its_steps_and_returns_its_state(tmp_path):
    graph = small_graph()
    config = {"configurable": {"thread_id": "t"}}
    timeline = Timeline(tmp_path / "t.json", {"id": "t"})

    state = follow(graph, {}, config, None, timeline)
    resumed = follow(graph, Command(resume={"approve": True}), config, None, timeline)

    steps = [e["step"] for e in timeline.data["events"]]
    assert steps == ["specialist", "diagnose", "review"]
    assert state["diagnosis"]["root_cause_service"] == "payments"
    assert resumed["review"] == {"approve": True}

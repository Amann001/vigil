import sqlite3

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from vigil import agents, llm
from vigil.agents import (
    MAX_ROUNDS,
    MAX_TOOL_CALLS,
    MAX_TOOL_RESULT_CHARS,
    Context,
    Diagnosis,
    Plan,
    Specialist,
    Task,
    bind_tool,
    build_graph,
    first_answer,
    run_specialist,
    structured_answer,
)


class FakeModel:
    """Stands in for a chat model: replays scripted replies and records what it was sent."""

    def __init__(self, replies=(), structured=None, error: Exception | None = None):
        self.replies = list(replies)
        self.structured = structured or {}  # schema -> list of answers (None = unparseable)
        self.error = error
        self.sent = []
        self.tool_choices = []

    def bind_tools(self, tools, tool_choice=None):
        self.tool_choices.append(tool_choice)
        return self

    def invoke(self, messages):
        self.sent.append(list(messages))
        if self.error:
            raise self.error
        return self.replies.pop(0)

    def with_structured_output(self, schema, method=None, include_raw=False):
        model = self

        class Asked:
            def invoke(self, messages):
                model.sent.append(list(messages))
                if model.error:
                    raise model.error
                parsed = model.structured[schema].pop(0)
                return {"raw": None, "parsed": parsed, "parsing_error": None if parsed else "bad"}

        return Asked()


def probe(evidence, service: str) -> str:
    """Report on one service."""
    return f"{service} looks {evidence}"


def tool_call(name: str, call_id: str = "1", **args) -> AIMessage:
    return AIMessage("", tool_calls=[{"name": name, "args": args, "id": call_id}])


@pytest.fixture
def one_tool(monkeypatch):
    monkeypatch.setitem(agents.SPECIALISTS, "metrics", Specialist("You test.", (probe,)))


def use_models(monkeypatch, **by_role):
    monkeypatch.setattr(
        llm, "models_for", lambda role: [(f"fake/{i}", m) for i, m in enumerate(by_role[role])]
    )


def test_bound_tool_hides_the_evidence_argument():
    tool = bind_tool("healthy", probe)

    assert tool.name == "probe"
    assert list(tool.args) == ["service"]
    assert tool.invoke({"service": "orders"}) == "orders looks healthy"


def test_specialist_runs_tools_and_reports(monkeypatch, one_tool):
    model = FakeModel([tool_call("probe", service="payments"), AIMessage("payments is down")])
    use_models(monkeypatch, metrics=[model])

    finding = run_specialist("metrics", "Is payments up?", "alert", evidence="down")

    assert finding["report"] == "payments is down"
    assert finding["tool_calls"] == [{"name": "probe", "args": {"service": "payments"}}]
    tool_result = model.sent[1][-1]
    assert isinstance(tool_result, ToolMessage) and tool_result.content == "payments looks down"
    assert finding["models"] == ["fake/0"]


def test_unknown_tools_and_bad_arguments_are_reported_back(monkeypatch, one_tool):
    model = FakeModel([tool_call("nope"), tool_call("probe", "2", wrong=1), AIMessage("done")])
    use_models(monkeypatch, metrics=[model])

    run_specialist("metrics", "q", "alert", evidence="x")

    assert "no tool named 'nope'" in model.sent[1][-1].content
    assert model.sent[2][-1].content.startswith("Tool error")


def huge(evidence) -> str:
    """Return far more text than a model should be sent."""
    return "x" * 10_000


def test_long_tool_results_are_truncated(monkeypatch):
    monkeypatch.setitem(agents.SPECIALISTS, "metrics", Specialist("r", (huge,)))
    model = FakeModel([tool_call("huge"), AIMessage("done")])
    use_models(monkeypatch, metrics=[model])

    run_specialist("metrics", "q", "alert", evidence=None)

    assert len(model.sent[1][-1].content) < MAX_TOOL_RESULT_CHARS + 50


def test_specialist_must_report_when_its_tool_budget_runs_out(monkeypatch, one_tool):
    calls = [tool_call("probe", str(i), service="orders") for i in range(MAX_TOOL_CALLS)]
    model = FakeModel([*calls, AIMessage("final report")])
    use_models(monkeypatch, metrics=[model])

    finding = run_specialist("metrics", "q", "alert", evidence="x")

    assert finding["report"] == "final report"
    assert len(finding["tool_calls"]) == MAX_TOOL_CALLS
    assert model.tool_choices[-1] == "none"


def test_a_failing_model_falls_back_to_the_next():
    broken = FakeModel(error=RuntimeError("429 rate limit"))
    working = FakeModel([AIMessage("hello")])

    reply, name = first_answer([("a", broken), ("b", working)], [])

    assert (reply.text, name) == ("hello", "b")


def test_every_model_failing_names_each_failure():
    with pytest.raises(RuntimeError, match="a: RuntimeError: down.*b: RuntimeError: down"):
        first_answer(
            [("a", FakeModel(error=RuntimeError("down")))] * 1
            + [("b", FakeModel(error=RuntimeError("down")))],
            [],
        )


def test_unparseable_structured_answers_fall_back(monkeypatch):
    plan = Plan(reasoning="r", tasks=[])
    use_models(
        monkeypatch,
        planner=[FakeModel(structured={Plan: [None]}), FakeModel(structured={Plan: [plan]})],
    )

    answer, name = structured_answer("planner", Plan, [])

    assert (answer, name) == (plan, "fake/1")


DIAGNOSIS = Diagnosis(
    root_cause_service="payments",
    category="service_crash",
    summary="payments crashed",
    evidence=["payments.up = 0"],
    affected_services=["orders", "storefront"],
    confidence="high",
    next_steps=["restart payments"],
)


def scripted_investigation(monkeypatch, one_tool):
    """Round 1 asks metrics a question; round 2 has enough evidence; then a diagnosis."""
    first = Plan(reasoning="unclear", tasks=[Task(agent="metrics", question="Is payments up?")])
    done = Plan(reasoning="payments is down", tasks=[])
    specialist = FakeModel([tool_call("probe", service="payments"), AIMessage("payments down")])
    use_models(
        monkeypatch,
        planner=[FakeModel(structured={Plan: [first, done]})],
        metrics=[specialist],
        diagnosis=[FakeModel(structured={Diagnosis: [DIAGNOSIS]})],
    )


def test_investigation_pauses_for_review_and_resumes_from_the_checkpoint(
    monkeypatch, one_tool, tmp_path
):
    scripted_investigation(monkeypatch, one_tool)
    database = tmp_path / "vigil.db"
    config = {"configurable": {"thread_id": "incident-1"}}

    with sqlite3.connect(database, check_same_thread=False) as connection:
        graph = build_graph(SqliteSaver(connection))
        paused = graph.invoke({"alert": "alert"}, config, context=Context(evidence="down"))

    assert paused["__interrupt__"][0].value == {"diagnosis": DIAGNOSIS.model_dump()}
    assert [f["report"] for f in paused["findings"]] == ["payments down"]
    assert paused["models"] == [
        "plan: fake/0",
        "metrics: fake/0",
        "plan: fake/0",
        "diagnosis: fake/0",
    ]

    # A new process: a fresh graph on the same database picks up where the first one stopped.
    with sqlite3.connect(database, check_same_thread=False) as connection:
        graph = build_graph(SqliteSaver(connection))
        decision = {"verdict": "confirmed", "notes": "matches what I saw"}
        finished = graph.invoke(Command(resume=decision), config, context=Context(evidence=None))

    assert finished["review"] == decision
    assert finished["diagnosis"]["root_cause_service"] == "payments"


def test_investigation_stops_asking_after_max_rounds(monkeypatch, one_tool):
    keep_asking = Plan(reasoning="more", tasks=[Task(agent="metrics", question="again?")])
    replies = []
    for _ in range(MAX_ROUNDS):
        replies += [tool_call("probe", service="orders"), AIMessage("still unclear")]
    use_models(
        monkeypatch,
        planner=[FakeModel(structured={Plan: [keep_asking] * MAX_ROUNDS})],
        metrics=[FakeModel(replies)],
        diagnosis=[FakeModel(structured={Diagnosis: [DIAGNOSIS]})],
    )
    from langgraph.checkpoint.memory import InMemorySaver

    graph = build_graph(InMemorySaver())
    state = graph.invoke(
        {"alert": "a"}, {"configurable": {"thread_id": "t"}}, context=Context(evidence="x")
    )

    assert len(state["findings"]) == MAX_ROUNDS
    assert state["round"] == MAX_ROUNDS + 1
    assert "diagnosis" in state

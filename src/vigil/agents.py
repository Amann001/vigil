"""The investigation: a supervisor agent directing specialist agents, as a LangGraph graph.

    alert -> plan -> specialists (in parallel) -> plan -> ... -> diagnose
          -> recall -> propose -> human review -> act -> report -> remember

- plan: the supervisor reads the alert and the findings so far, and either asks specialists
  focused questions or decides it has enough evidence. At most MAX_ROUNDS rounds.
- specialists (metrics, logs, deploy): each answers its question by calling its own tools in a
  loop, then reports what it found with numbers and times.
- diagnose: the supervisor writes a structured root-cause diagnosis from the findings.
- recall: runbooks and earlier incidents like this diagnosis are found in memory.
- propose: the remediation agent proposes one action from the catalogue, citing what it used.
- review: the graph pauses until a human confirms or corrects the diagnosis and approves or
  rejects the proposal. Every step is checkpointed, so this can happen later, elsewhere.
- act: an approved proposal runs if the guardrails allow it (vigil.actions).
- report: the communications agent writes the incident report.
- remember: the reviewed incident is stored in memory for future investigations.

Every model call tries the role's models in order (see vigil.llm) and records which one
answered, because free tiers fail over often and results must say which model produced them.
"""

import inspect
import operator
from dataclasses import dataclass
from typing import Annotated, Literal, TypedDict

import pandas as pd
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import StructuredTool
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from langgraph.types import Send, interrupt
from pydantic import BaseModel, Field

from vigil import llm, tools
from vigil.actions import ACTIONS, AuditLog, DryRunExecutor, Executor, Proposal, carry_out
from vigil.evidence import Evidence
from vigil.memory import Memory, incident_document

MAX_ROUNDS = 2
MAX_TOOL_CALLS = 5  # model turns per specialist per question
# Every tool result stays in the conversation and is re-sent on each call; capping it keeps a
# specialist's requests within free-tier limits (Groq: 7,000 input tokens per minute per model).
MAX_TOOL_RESULT_CHARS = 2500
MAX_ERROR_CHARS = 200

ARCHITECTURE = """\
The shop has four services. Customers call storefront. storefront calls inventory (stock levels)
and orders (checkout). orders calls inventory (reserve stock) and payments (charge the card).
When a service fails, the services calling it fail or slow down too: the root cause is the
service whose own problem explains the others, not the one with the most errors.
Earlier problems that had already recovered before the alert are not its cause."""

AgentName = Literal["metrics", "logs", "deploy"]


@dataclass(frozen=True)
class Specialist:
    role: str
    tools: tuple


SPECIALISTS: dict[str, Specialist] = {
    "metrics": Specialist(
        "You analyse metrics: request rates, error ratios, latency, memory and CPU per service, "
        "and calls between services.",
        (tools.service_overview, tools.dependency_overview, tools.metric_history),
    ),
    "logs": Specialist(
        "You analyse logs: which warnings and errors appear, which kinds of log line are new, "
        "and what the individual lines say.",
        (tools.log_summary, tools.search_logs),
    ),
    "deploy": Specialist(
        "You track changes to the running system: restarts, downtime and availability of each "
        "service, and how resources such as memory behaved before a service went down.",
        (tools.availability, tools.metric_history),
    ),
}

SPECIALIST_PROMPT = """\
You are the {name} specialist in an on-call team investigating a production alert.
{role}
{architecture}

Answer the supervisor's question using your tools. Then report your findings in at most 150
words: facts with numbers and times (relative to the alert), and which service each fact is
about. Separate what you observed from what you infer. Do not guess beyond the evidence.
Tools look back at most 15 minutes. Focus on what changed shortly before the alert: a problem
that started earlier and had already recovered is context, not the cause of this alert."""


class Task(BaseModel):
    agent: AgentName
    question: str = Field(description="One focused question for this specialist")


class Plan(BaseModel):
    reasoning: str = Field(description="What is known so far and what is still unclear")
    tasks: list[Task] = Field(
        description="Questions for specialists; empty if the evidence suffices"
    )


PLAN_PROMPT = """\
You are the supervisor of an on-call team investigating a production alert.
{architecture}

Specialists you can ask: metrics (service health, calls between services, metric history),
logs (warnings, errors, new kinds of log line), deploy (restarts, downtime, resource use before a
service went down). This is round {round} of {max_rounds}. Ask each specialist at most one
focused question. Return no tasks if the findings already identify the root cause clearly."""


class Diagnosis(BaseModel):
    root_cause_service: Literal["storefront", "orders", "payments", "inventory", "unknown"]
    category: Literal["service_crash", "memory_leak", "slow_responses", "error_responses", "other"]
    summary: str = Field(description="Two or three sentences: what happened and why")
    evidence: list[str] = Field(description="The specific findings that support the diagnosis")
    affected_services: list[str] = Field(description="Services impacted by the root cause")
    confidence: Literal["low", "medium", "high"]
    next_steps: list[str] = Field(description="What an engineer should check or do next")


DIAGNOSE_PROMPT = """\
You are the supervisor of an on-call team. Write the root-cause diagnosis for the alert from the
specialists' findings.
{architecture}

Categories:
- service_crash: the service process stopped without a prior build-up of resource use.
- memory_leak: memory grew steadily, possibly until the service was killed.
- slow_responses: the service itself became slow.
- error_responses: the service itself returned errors while running.
- other: none of the above fits.

Base every claim on the findings. If they do not support a clear conclusion, use "unknown" or
low confidence rather than guessing."""


class Investigation(TypedDict, total=False):
    id: str
    alert: str
    alert_at: str
    round: int
    tasks: list[dict]
    findings: Annotated[list[dict], operator.add]
    models: Annotated[list[str], operator.add]  # which model answered each step
    diagnosis: dict
    recalled: list[dict]  # runbooks and past incidents found in memory
    proposal: dict
    review: dict  # the human's decision: verdict, notes, approve, by
    action: dict  # what happened to the proposal (see vigil.actions.carry_out)
    report: str  # the incident report


@dataclass
class Context:
    """Runtime context: not checkpointed, so it is supplied again when an investigation resumes.

    Without memory nothing is recalled or remembered; without an executor actions are dry runs.
    """

    evidence: Evidence
    memory: Memory | None = None
    executor: Executor | None = None
    audit: AuditLog | None = None


def _failure(name: str, error: Exception) -> str:
    return f"{name}: {type(error).__name__}: {str(error)[:MAX_ERROR_CHARS]}"


def first_answer(models: list, messages: list):
    """The first model that answers, and its name. A model that errors (rate limit, outage)
    is skipped in favour of the next."""
    errors = []
    for name, model in models:
        try:
            return model.invoke(messages), name
        except Exception as error:
            errors.append(_failure(name, error))
    raise RuntimeError("Every model failed. " + " | ".join(errors))


def structured_answer(role: str, schema: type[BaseModel], messages: list) -> tuple[BaseModel, str]:
    """Like first_answer, for an answer that must match `schema`; unparseable answers are also
    skipped in favour of the next model."""
    errors = []
    for name, model in llm.models_for(role):
        try:
            asked = model.with_structured_output(
                schema, method="function_calling", include_raw=True
            )
            result = asked.invoke(messages)
        except Exception as error:
            errors.append(_failure(name, error))
            continue
        if result["parsed"] is not None:
            return result["parsed"], name
        errors.append(f"{name}: unparseable answer: {result['parsing_error']}")
    raise RuntimeError(f"Every {role} model failed. " + " | ".join(errors))


def _findings_text(findings: list[dict]) -> str:
    if not findings:
        return "No findings yet."
    return "\n\n".join(f"[{f['agent']}] Q: {f['question']}\nA: {f['report']}" for f in findings)


def plan(state: Investigation) -> dict:
    round_number = state.get("round", 0) + 1
    if round_number > MAX_ROUNDS:
        return {"round": round_number, "tasks": []}
    prompt = PLAN_PROMPT.format(
        architecture=ARCHITECTURE, round=round_number, max_rounds=MAX_ROUNDS
    )
    findings = _findings_text(state.get("findings", []))
    result, model = structured_answer(
        "planner",
        Plan,
        [SystemMessage(prompt), HumanMessage(f"{state['alert']}\n\nFindings so far:\n{findings}")],
    )
    tasks = [task.model_dump() for task in result.tasks]
    return {"round": round_number, "tasks": tasks, "models": [f"plan: {model}"]}


def route(state: Investigation) -> list[Send] | str:
    if not state.get("tasks"):
        return "diagnose"
    return [Send("specialist", {"alert": state["alert"], "task": task}) for task in state["tasks"]]


def bind_tool(evidence: Evidence, function) -> StructuredTool:
    """A tool for the model: the function with its `evidence` argument filled in and hidden, so
    the model only sees (and chooses) the remaining arguments."""

    def call(**kwargs):
        return function(evidence, **kwargs)

    signature = inspect.signature(function)
    call.__signature__ = signature.replace(parameters=list(signature.parameters.values())[1:])
    call.__annotations__ = {k: v for k, v in function.__annotations__.items() if k != "evidence"}
    return StructuredTool.from_function(
        func=call, name=function.__name__, description=function.__doc__
    )


def _run_tool(tool: StructuredTool | None, call: dict) -> str:
    if tool is None:
        return f"Tool error: there is no tool named {call['name']!r}"
    try:
        text = str(tool.invoke(call["args"]))
    except Exception as error:  # a bad argument is reported back to the model, not fatal
        return f"Tool error: {error}"
    if len(text) > MAX_TOOL_RESULT_CHARS:
        text = text[:MAX_TOOL_RESULT_CHARS] + " [truncated: ask a narrower question]"
    return text


def run_specialist(name: str, question: str, alert: str, evidence: Evidence) -> dict:
    """The specialist's tool loop: ask the model, run the tools it calls, repeat, then report."""
    specialist = SPECIALISTS[name]
    bound = [bind_tool(evidence, function) for function in specialist.tools]
    by_name = {tool.name: tool for tool in bound}
    models = llm.models_for(name)
    with_tools = [(model_name, model.bind_tools(bound)) for model_name, model in models]
    prompt = SPECIALIST_PROMPT.format(name=name, role=specialist.role, architecture=ARCHITECTURE)
    messages = [
        SystemMessage(prompt),
        HumanMessage(f"{alert}\n\nSupervisor's question: {question}"),
    ]
    calls, used = [], set()
    for _ in range(MAX_TOOL_CALLS):
        reply, model_name = first_answer(with_tools, messages)
        used.add(model_name)
        messages.append(reply)
        if not reply.tool_calls:
            break
        for call in reply.tool_calls:
            calls.append({"name": call["name"], "args": call["args"]})
            result = _run_tool(by_name.get(call["name"]), call)
            messages.append(ToolMessage(result, tool_call_id=call["id"]))
    else:
        messages.append(HumanMessage("Your tool budget is used up. Report your findings now."))
        no_tools = [(n, m.bind_tools(bound, tool_choice="none")) for n, m in models]
        reply, model_name = first_answer(no_tools, messages)
        used.add(model_name)
    return {
        "agent": name,
        "question": question,
        "report": reply.text,
        "tool_calls": calls,
        "models": sorted(used),
    }


def specialist(payload: dict, runtime: Runtime[Context]) -> dict:
    task = payload["task"]
    finding = run_specialist(
        task["agent"], task["question"], payload["alert"], runtime.context.evidence
    )
    return {
        "findings": [finding],
        "models": [f"{task['agent']}: {model}" for model in finding["models"]],
    }


def diagnose(state: Investigation) -> dict:
    findings = _findings_text(state.get("findings", []))
    result, model = structured_answer(
        "diagnosis",
        Diagnosis,
        [
            SystemMessage(DIAGNOSE_PROMPT.format(architecture=ARCHITECTURE)),
            HumanMessage(f"{state['alert']}\n\nFindings:\n{findings}"),
        ],
    )
    return {"diagnosis": result.model_dump(), "models": [f"diagnosis: {model}"]}


RUNBOOKS_RECALLED = 2
INCIDENTS_RECALLED = 3


def _diagnosis_query(diagnosis: dict) -> str:
    category = diagnosis["category"].replace("_", " ")
    return f"{diagnosis['root_cause_service']} {category}. {diagnosis['summary']}"


def recall(state: Investigation, runtime: Runtime[Context]) -> dict:
    """Find the runbooks and past incidents most like this diagnosis.

    The diagnosis is the query, not the alert: measured on the campaign, searching with a raw
    alert (a list of metric names) put the wrong runbook first every time."""
    memory = runtime.context.memory
    if memory is None:
        return {"recalled": []}
    query = _diagnosis_query(state["diagnosis"])
    runbooks = memory.search(query, kinds=["runbook"], limit=RUNBOOKS_RECALLED)
    incidents = memory.search(
        query,
        kinds=["incident"],
        before=pd.Timestamp(state["alert_at"]),
        exclude=state["id"],
        limit=INCIDENTS_RECALLED,
    )
    recalled = [
        {
            "id": hit.document.id,
            "kind": hit.document.kind,
            "title": hit.document.title,
            "body": hit.document.body,
        }
        for hit in runbooks + incidents
    ]
    return {"recalled": recalled}


class ProposalAnswer(Proposal):
    cited_incidents: list[str] = Field(
        description="Ids of the past incidents that informed this proposal; empty if none did"
    )


PROPOSE_PROMPT = """\
You are the remediation agent of an on-call team. Propose exactly one action to fix the
diagnosed root cause, following the runbooks below. A human approves or rejects your proposal
before anything happens.
{architecture}

Available actions:
{actions}

Rules:
- Act only on the root-cause service, never on services that are only affected by it.
- Propose escalate if no action would fix the cause safely, the root cause is unknown, or the
  diagnosis has low confidence.
- Cite the past incidents (by id) that informed the proposal, and none that did not.

{recalled}"""


def _recalled_text(recalled: list[dict]) -> str:
    if not recalled:
        return "No runbooks or past incidents were found in memory."
    blocks = [f"[{r['kind']} {r['id']}] {r['title']}\n{r['body']}" for r in recalled]
    return "From memory:\n\n" + "\n\n".join(blocks)


def propose(state: Investigation) -> dict:
    actions = "\n".join(f"- {name}: {a.description}" for name, a in ACTIONS.items())
    prompt = PROPOSE_PROMPT.format(
        architecture=ARCHITECTURE,
        actions=actions,
        recalled=_recalled_text(state.get("recalled", [])),
    )
    result, model = structured_answer(
        "remediation",
        ProposalAnswer,
        [SystemMessage(prompt), HumanMessage(f"Diagnosis:\n{state['diagnosis']}")],
    )
    proposal = result.model_dump()
    # Only incidents that were actually recalled can be cited; anything else is invented.
    known = {r["id"] for r in state.get("recalled", []) if r["kind"] == "incident"}
    proposal["cited_incidents"] = [i for i in proposal["cited_incidents"] if i in known]
    return {"proposal": proposal, "models": [f"remediation: {model}"]}


def review(state: Investigation) -> dict:
    """Pause until a human reviews the diagnosis and approves or rejects the proposal.

    Resumed with Command(resume={"verdict": "confirmed" | "corrected", "notes": ...,
    "approve": bool, "by": ...})."""
    decision = interrupt(
        {
            "diagnosis": state["diagnosis"],
            "proposal": state["proposal"],
            "recalled": [r["id"] for r in state.get("recalled", [])],
        }
    )
    return {"review": decision}


def act(state: Investigation, runtime: Runtime[Context]) -> dict:
    """Carry out the proposal if the human approved it and the guardrails allow it."""
    decision = state["review"]
    fields = {k: v for k, v in state["proposal"].items() if k in Proposal.model_fields}
    entry = carry_out(
        Proposal(**fields),
        {
            "approved": decision.get("approve", False),
            "by": decision.get("by"),
            "notes": decision.get("notes"),
        },
        runtime.context.executor or DryRunExecutor(),
        runtime.context.audit or AuditLog(),
        incident=state["id"],
    )
    return {"action": entry}


REPORT_PROMPT = """\
You are the communications agent of an on-call team. Write the incident report in Markdown
with these sections: Summary, Impact, Root cause, Evidence, Resolution, Follow-ups, Similar
past incidents. Use only the facts given; do not invent times, numbers or actions. If the
action was a dry run, rejected or refused, say so plainly: nothing was changed."""


def report(state: Investigation) -> dict:
    facts = {key: state.get(key) for key in ("alert", "diagnosis", "proposal", "review", "action")}
    reply, model = first_answer(
        llm.models_for("comms"),
        [SystemMessage(REPORT_PROMPT), HumanMessage(f"Facts:\n{facts}")],
    )
    return {"report": reply.text, "models": [f"comms: {model}"]}


def remember(state: Investigation, runtime: Runtime[Context]) -> dict:
    """Store the reviewed incident, with the human's verdict and the action's outcome."""
    if runtime.context.memory is not None:
        record = {
            key: state.get(key) for key in ("id", "alert_at", "diagnosis", "review", "action")
        }
        runtime.context.memory.add([incident_document(record)])
    return {}


def build_graph(checkpointer=None):
    graph = StateGraph(Investigation, context_schema=Context)
    steps = [plan, specialist, diagnose, recall, propose, review, act, report, remember]
    for step in steps:
        graph.add_node(step.__name__, step)
    graph.add_edge(START, "plan")
    graph.add_conditional_edges("plan", route, ["specialist", "diagnose"])
    graph.add_edge("specialist", "plan")
    for before, after in [
        ("diagnose", "recall"),
        ("recall", "propose"),
        ("propose", "review"),
        ("review", "act"),
        ("act", "report"),
        ("report", "remember"),
        ("remember", END),
    ]:
        graph.add_edge(before, after)
    return graph.compile(checkpointer=checkpointer)

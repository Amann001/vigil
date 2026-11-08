"""Tracing investigations with Langfuse: every model call, tool call and graph step, timed.

When the Langfuse keys are in .env, each run of the graph (an investigation, or the work after
a review) is sent to Langfuse Cloud as a trace: which model answered each step, the prompt and
the answer, tokens used, how long each tool took. Traces of one investigation share a session
id (the investigation id), so investigating and reviewing it appear together.

Without keys, tracing is off and nothing leaves the machine.
"""

import os

from dotenv import load_dotenv

from shop.config import PROJECT_ROOT

KEYS = ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY")


def enabled() -> bool:
    load_dotenv(PROJECT_ROOT / ".env")
    return all(os.environ.get(key) for key in KEYS)


def run_config(investigation_id: str, step: str) -> dict:
    """Extra LangGraph run configuration that traces this run, or nothing if tracing is off."""
    if not enabled():
        return {}
    # Newer Langfuse SDKs read LANGFUSE_BASE_URL; .env.example names it LANGFUSE_HOST.
    if os.environ.get("LANGFUSE_HOST") and not os.environ.get("LANGFUSE_BASE_URL"):
        os.environ["LANGFUSE_BASE_URL"] = os.environ["LANGFUSE_HOST"]
    from langfuse.langchain import CallbackHandler

    return {
        "callbacks": [CallbackHandler()],
        "metadata": {
            "langfuse_session_id": investigation_id,
            "langfuse_trace_name": f"{step}: {investigation_id}",
            "langfuse_tags": ["vigil", step],
        },
    }


def flush() -> None:
    """Send buffered traces now; the SDK sends in the background and a process may exit first."""
    if enabled():
        from langfuse import get_client

        get_client().flush()

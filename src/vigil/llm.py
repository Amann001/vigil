"""Which language model each agent uses, behind LangChain's provider-agnostic chat interface.

Groq is reached through its OpenAI-compatible API and Gemini through Google's own client:
Gemini 3 attaches a "thought signature" to every tool call that must be sent back on the next
turn, and the OpenAI-compatible route drops it.

Every agent has a primary model and a fallback on the other provider, because free tiers are
rate-limited and sometimes overloaded. Rate limits apply *per model* (Groq: 8,000 tokens per
minute), so the three specialists, which run in parallel, each get a different primary model.
"""

import os

from dotenv import load_dotenv
from langchain_core.language_models import BaseChatModel
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_openai import ChatOpenAI

from shop.config import PROJECT_ROOT

GROQ_URL = "https://api.groq.com/openai/v1"
KEY_VARIABLES = {"gemini": "GEMINI_API_KEY", "groq": "GROQ_API_KEY"}
GEMINI = ("gemini", "gemini-3.5-flash")

# Free-tier budgets decide the allocation (limits are per model, and reset daily or per minute):
# - Gemini 3.5 Flash, the strongest, allows only 20 requests a day, so it writes the diagnosis:
#   one call per investigation.
# - Groq allows 1,000 requests and 200,000 tokens a day, and 8,000 tokens a minute, per model;
#   about ten investigations exhaust gpt-oss-120b for the day. Gemini Flash-Lite is
#   the third budget. Specialists run in parallel, so each gets a different primary model.
# Qwen 3.8 was tried for logs and dropped: it called a tool that does not exist in 1 of 3 tries.
GEMINI_LITE = ("gemini", "gemini-3.1-flash-lite")
GROQ_LARGE = ("groq", "openai/gpt-oss-120b")
GROQ_SMALL = ("groq", "openai/gpt-oss-20b")
ROLES = {
    "planner": [GROQ_LARGE, GEMINI_LITE],
    "diagnosis": [GEMINI, GROQ_LARGE, GEMINI_LITE],
    "metrics": [GROQ_LARGE, GEMINI_LITE],
    "logs": [GROQ_SMALL, GEMINI_LITE],
    "deploy": [GEMINI_LITE, GROQ_SMALL],
    "remediation": [GROQ_LARGE, GEMINI_LITE],
    "comms": [GROQ_SMALL, GEMINI_LITE],
}
TIMEOUT_SECONDS = 90
# Rate-limit errors say how long to wait; retrying a few times rides out a busy minute before
# falling back to the other provider.
MAX_RETRIES = 6


def _key(provider: str) -> str:
    load_dotenv(PROJECT_ROOT / ".env")
    variable = KEY_VARIABLES[provider]
    if not (key := os.environ.get(variable)):
        raise RuntimeError(f"{variable} is not set: add it to .env")
    return key


def chat_model(provider: str, model: str) -> BaseChatModel:
    if provider == "gemini":
        # Gemini 3 is tuned for its default temperature; lowering it can cause looping.
        return ChatGoogleGenerativeAI(
            model=model,
            google_api_key=_key("gemini"),
            timeout=TIMEOUT_SECONDS,
            max_retries=MAX_RETRIES,
        )
    return ChatOpenAI(
        model=model,
        base_url=GROQ_URL,
        api_key=_key("groq"),
        temperature=0.0,  # investigations should be as repeatable as the provider allows
        timeout=TIMEOUT_SECONDS,
        max_retries=MAX_RETRIES,
    )


def models_for(role: str) -> list[tuple[str, BaseChatModel]]:
    """The role's models as (name, model), primary first."""
    return [(f"{provider}/{model}", chat_model(provider, model)) for provider, model in ROLES[role]]


def describe(role: str) -> str:
    return " -> ".join(f"{provider}/{model}" for provider, model in ROLES[role])

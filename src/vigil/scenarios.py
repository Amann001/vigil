"""Exam scenarios: what to break, when, and what the right answer is.

A scenario file is TOML with one [[scenario]] table per scenario (format: docs/SCENARIOS.md).
Loading validates everything up front: unknown settings (typos) and impossible values are
errors, so a run never starts with a scenario that would be misread.

Error messages say where a problem is (scenario 3, step 2, which setting) but never repeat
what a scenario contains, so a hidden scenario file can be checked without revealing it.
"""

import tomllib
from pathlib import Path
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

Service = Literal["storefront", "orders", "payments", "inventory"]
FaultKind = Literal["latency", "errors", "leak", "crash", "cpu", "traffic"]
Category = Literal[
    "service_crash",
    "memory_leak",
    "slow_responses",
    "error_responses",
    "not_an_incident",
    "other",
]
Fix = Literal["restart_service", "escalate", "no_action"]
FAULT_SETTINGS = {
    "latency": {"latency_seconds", "fraction"},
    "errors": {"error_rate"},
    "leak": {"leak_mb_per_second", "leak_limit_mb"},
    "crash": set(),
    "cpu": {"cpu_seconds", "fraction"},
    "traffic": {"multiplier"},
}
ALL_SETTINGS = set().union(*FAULT_SETTINGS.values())


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Step(Strict):
    at: float = Field(ge=0, le=3600, description="seconds after the scenario starts")
    fault: FaultKind
    service: Service | None = None
    duration_seconds: float | None = Field(None, gt=0, le=3600)
    latency_seconds: float | None = Field(None, gt=0, le=30)
    fraction: float | None = Field(None, gt=0, le=1)
    error_rate: float | None = Field(None, gt=0, le=1)
    leak_mb_per_second: float | None = Field(None, gt=0, le=100)
    leak_limit_mb: float | None = Field(None, gt=0, le=4000)
    cpu_seconds: float | None = Field(None, gt=0, le=2)
    multiplier: float | None = Field(None, gt=0, le=10)

    @model_validator(mode="after")
    def settings_fit_the_fault(self) -> Self:
        if self.fault == "traffic":
            if self.service is not None:
                raise ValueError("a traffic step applies to the whole shop: remove service")
            if self.multiplier is None or self.duration_seconds is None:
                raise ValueError("a traffic step needs multiplier and duration_seconds")
        elif self.service is None:
            raise ValueError(f"a {self.fault} step needs a service")
        if self.fault == "crash" and self.duration_seconds is not None:
            raise ValueError("a crash has no duration: the service stays down until restarted")
        given = {name for name in ALL_SETTINGS if getattr(self, name) is not None}
        if extra := given - FAULT_SETTINGS[self.fault]:
            raise ValueError(f"{', '.join(sorted(extra))} do not apply to {self.fault}")
        return self

    @property
    def ends_at(self) -> float:
        return self.at + (self.duration_seconds or 0)

    def fault_request(self) -> dict:
        """The settings to send to the shop's fault injection (shop.chaos.FaultRequest)."""
        settings = {name: getattr(self, name) for name in FAULT_SETTINGS[self.fault]}
        given = {k: v for k, v in settings.items() if v is not None}
        return {"fault": self.fault, "duration_seconds": self.duration_seconds, **given}


class Expected(Strict):
    root_cause_service: Service | Literal["none"]
    category: Category
    fix: Fix

    @model_validator(mode="after")
    def consistent(self) -> Self:
        no_incident = self.category == "not_an_incident"
        if no_incident != (self.root_cause_service == "none"):
            raise ValueError('use root_cause_service "none" exactly when not_an_incident')
        if no_incident and self.fix != "no_action":
            raise ValueError("when nothing is broken the fix is no_action")
        return self


class Scenario(Strict):
    name: str = Field(min_length=1, max_length=80)
    description: str = ""
    observe_seconds: float = Field(300, ge=60, le=1800, description="how long to watch")
    steps: list[Step] = Field(default_factory=list, max_length=20)
    expected: Expected

    @model_validator(mode="after")
    def steps_fit_in_the_window(self) -> Self:
        if self.expected.category != "not_an_incident" and not self.steps:
            raise ValueError("an incident needs at least one step that causes it")
        return self

    @property
    def window_seconds(self) -> float:
        """Long enough to watch the whole scenario: every step has ended."""
        return max([self.observe_seconds, *(s.ends_at + 60 for s in self.steps)])

    @property
    def restarts_needed(self) -> set[str]:
        """Services left damaged (killed, or holding leaked memory) when the scenario ends."""
        return {s.service for s in self.steps if s.fault in ("crash", "leak")}


class ScenarioError(ValueError):
    pass


def _where(location: tuple) -> str:
    parts = []
    for i, part in enumerate(location):
        if part == "scenario" and i + 1 < len(location) and isinstance(location[i + 1], int):
            continue
        if isinstance(part, int):
            parts.append(f"{'scenario' if not parts else 'step'} {part + 1}")
        elif part != "steps" and "[" not in str(part):  # skip pydantic's union branch names
            parts.append(str(part))
    return ", ".join(parts) or "file"


def load(path: Path) -> list[Scenario]:
    """Every scenario in a TOML file, validated; raises ScenarioError listing every problem."""
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as error:
        raise ScenarioError(f"{path.name} is not valid TOML: {error}") from None
    raw = data.get("scenario")
    if not isinstance(raw, list) or not raw:
        raise ScenarioError(f"{path.name} has no [[scenario]] tables")
    problems, scenarios = [], []
    for number, item in enumerate(raw, start=1):
        try:
            scenarios.append(Scenario.model_validate(item))
        except ValidationError as error:
            for e in error.errors(include_input=False, include_url=False):
                where = _where(("scenario", number - 1, *e["loc"]))
                problems.append(f"{where}: {e['msg']}")
    if problems:
        raise ScenarioError("\n".join(dict.fromkeys(problems)))  # unions report once per branch
    names = [s.name for s in scenarios]
    if len(set(names)) != len(names):
        raise ScenarioError("two scenarios have the same name; names must be unique")
    return scenarios

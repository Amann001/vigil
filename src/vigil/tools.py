"""The tools Vigil's agents call to gather evidence. Each returns a short text report.

Reports compare "now" with a healthy-looking baseline (the median of the half hour before the
window) because a number alone ("p95 = 0.8 s") means little to an investigator; "0.8 s, usually
0.05 s" is evidence. Times are shown relative to the moment of the alert ("-2m30s").
"""

import pandas as pd

from vigil.evidence import Evidence
from vigil.logparse import LogParser
from vigil.telemetry import DEPENDENCIES, SERVICES

BASELINE_MINUTES = 30
# Agents asked for an hour or two of history and then blamed earlier, already-resolved problems.
# Real investigations start from what changed just before the alert, so windows are capped.
MAX_MINUTES = 15
SERVICE_SIGNALS = {
    "up": ("up", "{:.0f}"),
    "request_rate": ("req/s", "{:.2f}"),
    "error_ratio": ("errors", "{:.1%}"),
    "latency_p95": ("p95 s", "{:.3f}"),
    "memory_mb": ("mem MB", "{:.0f}"),
    "cpu": ("cpu", "{:.2f}"),
}
DEPENDENCY_SIGNALS = {
    "failure_ratio": ("failures", "{:.1%}"),
    "latency_p95": ("p95 s", "{:.3f}"),
}
# Same setting as the log features: short fixed messages that differ by one word are different.
LOG_TEMPLATE_SIMILARITY = 0.7
MAX_MESSAGE_CHARS = 160


def _ago(timestamp: pd.Timestamp, as_of: pd.Timestamp) -> str:
    seconds = int((as_of - timestamp).total_seconds())
    return f"-{seconds // 60}m{seconds % 60:02d}s"


def _format(value: float, pattern: str) -> str:
    return "missing" if pd.isna(value) else pattern.format(value)


def _now_and_baseline(evidence: Evidence, minutes: float) -> tuple[pd.DataFrame, pd.DataFrame]:
    table = evidence.metrics(minutes + BASELINE_MINUTES)
    split = evidence.as_of - pd.Timedelta(minutes=minutes)
    return table[table.index > split], table[table.index <= split]


def _compare(now: pd.DataFrame, baseline: pd.DataFrame, column: str, pattern: str) -> str:
    # "Now" is the latest sample: Prometheus already averages each one over 30 s, and averaging
    # the last minute again made a service that died 30 s ago look half healthy. A series that
    # stopped reporting is shown as missing, which is itself evidence.
    current = now[column].iloc[-1] if column in now and len(now) else float("nan")
    usual = baseline[column].median() if column in baseline else float("nan")
    worst = now[column].max() if column in now else float("nan")
    current, usual, worst = (_format(v, pattern) for v in (current, usual, worst))
    return f"{current} (usual {usual}, worst {worst})"


def service_overview(evidence: Evidence, minutes: float = 5) -> str:
    """Each service's health now (latest sample) compared with its usual values."""
    minutes = min(minutes, MAX_MINUTES)
    now, baseline = _now_and_baseline(evidence, minutes)
    lines = [f"Service health at the alert; worst = worst value in the last {minutes:g} min."]
    for service in SERVICES:
        parts = [
            f"{label}={_compare(now, baseline, f'{service}.{signal}', pattern)}"
            for signal, (label, pattern) in SERVICE_SIGNALS.items()
        ]
        lines.append(f"- {service}: " + "; ".join(parts))
    return "\n".join(lines)


def dependency_overview(evidence: Evidence, minutes: float = 5) -> str:
    """Calls between services: failure ratio and latency, compared with usual."""
    minutes = min(minutes, MAX_MINUTES)
    now, baseline = _now_and_baseline(evidence, minutes)
    lines = ["Calls between services (caller -> callee):"]
    for caller, callee in DEPENDENCIES:
        name = f"{caller}->{callee}"
        parts = [
            f"{label}={_compare(now, baseline, f'{name}.{signal}', pattern)}"
            for signal, (label, pattern) in DEPENDENCY_SIGNALS.items()
        ]
        lines.append(f"- {name}: " + "; ".join(parts))
    customers = _compare(now, baseline, "customers.error_ratio", "{:.1%}")
    lines.append(f"- customers seeing errors: {customers}")
    return "\n".join(lines)


def metric_history(evidence: Evidence, metric: str, minutes: float = 10) -> str:
    """One metric over time, every 30 s. Names look like 'orders.latency_p95'."""
    minutes = min(minutes, MAX_MINUTES)
    table = evidence.metrics(minutes)
    if metric not in table:
        return f"Unknown metric {metric!r}. Known metrics: {', '.join(table.columns)}"
    # Buckets end at the last sample, so the newest point is "now" rather than a clock boundary.
    series = table[metric].resample("30s", label="right", closed="right", origin="end").mean()
    points = [f"{_ago(t, evidence.as_of)}: {_format(v, '{:.4g}')}" for t, v in series.items()]
    return f"{metric} (30 s averages, oldest first):\n" + "\n".join(points)


def availability(evidence: Evidence, minutes: float = 15) -> str:
    """When each service was down, and restarts (back up after being down, or memory reset)."""
    minutes = min(minutes, MAX_MINUTES)
    table = evidence.metrics(minutes)
    lines = [f"Availability in the last {minutes:g} min:"]
    for service in SERVICES:
        up = table[f"{service}.up"].fillna(0) >= 1
        down_runs = (up != up.shift()).cumsum()[~up]
        periods = [
            f"down {_ago(run.index[0], evidence.as_of)} to {_ago(run.index[-1], evidence.as_of)}"
            for _, run in down_runs.groupby(down_runs)
        ]
        memory = table[f"{service}.memory_mb"]
        resets = memory[(memory < 0.5 * memory.shift()) & memory.notna()]
        periods += [
            f"memory reset {_ago(t, evidence.as_of)} ({memory.shift()[t]:.0f} -> {v:.0f} MB)"
            for t, v in resets.items()
        ]
        status = "up now" if up.iloc[-1] else "DOWN now"
        lines.append(f"- {service}: {status}; " + ("; ".join(periods) or "no downtime"))
    return "\n".join(lines)


def _template_keys(logs: pd.DataFrame) -> pd.Series:
    parser = LogParser(similarity=LOG_TEMPLATE_SIMILARITY)
    groups = parser.parse(logs["message"].astype(str))
    return pd.Series(
        [
            f"{level} {logger}: {parser.templates[group]}"
            for level, logger, group in zip(logs["level"], logs["logger"], groups, strict=True)
        ],
        index=logs.index,
    )


def log_summary(evidence: Evidence, service: str | None = None, minutes: float = 5) -> str:
    """Kinds of log line in the window with counts; NEW marks kinds absent from the half hour
    before. Only warnings and errors are listed."""
    minutes = min(minutes, MAX_MINUTES)
    logs = evidence.logs(minutes + BASELINE_MINUTES)
    if service:
        logs = logs[logs["service"] == service]
    if logs.empty:
        return "No log lines found."
    logs = logs.assign(kind=_template_keys(logs))
    split = evidence.as_of - pd.Timedelta(minutes=minutes)
    recent, before = logs[logs["timestamp"] > split], logs[logs["timestamp"] <= split]
    known = set(before["kind"])

    counts = recent.groupby(["service", "level"]).size()
    lines = [f"Log lines in the last {minutes:g} min by service and level:"]
    lines += [f"- {svc} {level}: {n}" for (svc, level), n in counts.items()]
    problems = recent[recent["level"].isin(["WARNING", "ERROR", "CRITICAL"])]
    lines.append("Warning and error kinds (count, service, first seen):")
    for kind, group in sorted(problems.groupby("kind"), key=lambda kv: -len(kv[1]))[:10]:
        new = " NEW" if kind not in known else ""
        first = _ago(group["timestamp"].iloc[0], evidence.as_of)
        services = ",".join(sorted(group["service"].unique()))
        lines.append(
            f"- {len(group)}x [{services}] {kind[:MAX_MESSAGE_CHARS]} (first {first}){new}"
        )
    if problems.empty:
        lines.append("- none")
    return "\n".join(lines)


def search_logs(
    evidence: Evidence,
    service: str | None = None,
    level: str | None = None,
    contains: str | None = None,
    minutes: float = 5,
    limit: int = 10,
) -> str:
    """Matching log lines with their fields, oldest first. `level` is INFO, WARNING or ERROR."""
    minutes = min(minutes, MAX_MINUTES)
    logs = evidence.logs(minutes)
    if service:
        logs = logs[logs["service"] == service]
    if level:
        logs = logs[logs["level"] == level.upper()]
    if contains:
        text = logs["message"].astype(str) + " " + logs["fields"].astype(str)
        logs = logs[text.str.contains(contains, case=False, regex=False)]
    if logs.empty:
        return "No matching log lines."
    shown = logs.tail(limit)
    lines = [f"{len(logs)} matching lines; the last {len(shown)}:"]
    for row in shown.itertuples():
        fields = {k: v for k, v in row.fields.items() if k not in ("request_id", "exception")}
        message = str(row.message).splitlines()[0][:MAX_MESSAGE_CHARS]
        lines.append(
            f"- {_ago(row.timestamp, evidence.as_of)} {row.service} {row.level} {row.logger}: "
            f"{message} {fields if fields else ''}".rstrip()
        )
    return "\n".join(lines)

"""The exam: play scenarios on the live shop, record them, then score Vigil on the recording.

    vigil exam check FILE               validate a scenario file (see docs/SCENARIOS.md)
    vigil exam record FILE --out DIR    play the scenarios one after another and record them
    vigil exam run DIR [--config NAME]  investigate the recording and score it

Recording and investigating are separate so that every configuration (the ablations) faces
exactly the same evidence, and the slow part, playing scenarios in real time, happens once.

Ground truth stays in DIR: the scenarios' expected answers (truth.json), the fault ledger, and
every investigation of the recording. Nothing about a hidden scenario set enters the
repository, and `run --hidden` prints totals only.

`run` can be stopped and started again: finished scenarios are kept, so a run that hits the
free tiers' daily limits simply continues the next day.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import httpx
import pandas as pd

from shop.chaos import FaultRequest, clear_fault, inject_fault
from shop.config import LOG_DIR
from shop.control import CONTROL_PORT
from shop.traffic import clear_surge, set_surge
from vigil.dataset import archive_raw_logs
from vigil.scenarios import Scenario, ScenarioError, load
from vigil.telemetry import PROMETHEUS_URL, SERVICES, fetch_features

WARMUP_SECONDS = 600  # healthy traffic before the first scenario, as a baseline
SETTLE_SECONDS = 240  # healthy gap between scenarios, so one does not bleed into the next
GRACE = pd.Timedelta("60s")  # an alert just after a scenario ends still belongs to it
CONTROL = f"http://127.0.0.1:{CONTROL_PORT}"
CONFIGS = ("full", "single-agent", "no-memory", "one-model")


def _now() -> pd.Timestamp:
    return pd.Timestamp.now(tz="UTC")


def _say(message: str) -> None:
    print(f"[{_now():%H:%M:%S}] {message}", flush=True)


# --- Recording ---------------------------------------------------------------------------


def shop_problems() -> list[str]:
    problems = []
    try:
        httpx.get(f"{PROMETHEUS_URL}/-/ready", timeout=5).raise_for_status()
    except httpx.HTTPError:
        problems.append("Prometheus is not reachable")
    try:
        status = httpx.get(f"{CONTROL}/status", timeout=5).json()
        problems += [f"{s} is not running" for s in SERVICES if not status[s]["running"]]
    except (httpx.HTTPError, KeyError):
        problems.append("the shop's control API is not reachable: start shop.launch")
    return problems


def restart(service: str) -> None:
    httpx.post(f"{CONTROL}/restart/{service}", timeout=90).raise_for_status()


def reset(ledger: Path, damaged: set[str] = frozenset()) -> None:
    """Back to a healthy shop: no surge, no faults, damaged or dead services restarted."""
    clear_surge()
    status = httpx.get(f"{CONTROL}/status", timeout=5).json()
    for service in SERVICES:
        if service in damaged or not status[service]["running"]:
            restart(service)
            continue
        try:
            clear_fault(service, ledger)
        except httpx.HTTPError:
            restart(service)


def _wait_until(deadline: float) -> None:
    while (remaining := deadline - time.monotonic()) > 0:
        time.sleep(min(remaining, 1.0))


def play(scenario: Scenario, ledger: Path) -> list[str]:
    """Carry out the scenario's steps on schedule, then wait out its window."""
    started, problems = time.monotonic(), []
    for step in sorted(scenario.steps, key=lambda s: s.at):
        _wait_until(started + step.at)
        try:
            if step.fault == "traffic":
                set_surge(step.multiplier, step.duration_seconds)
            else:
                inject_fault(step.service, FaultRequest(**step.fault_request()), ledger)
        except httpx.HTTPError as error:  # e.g. the service is already down
            problems.append(f"step at {step.at:g} s: {type(error).__name__}")
    _wait_until(started + scenario.window_seconds)
    return problems


def export(out: Path, started: pd.Timestamp, warmup_end: pd.Timestamp, ended: pd.Timestamp):
    with httpx.Client(base_url=PROMETHEUS_URL, timeout=120) as client:
        features = fetch_features(started.to_pydatetime(), ended.to_pydatetime(), client)
    features.to_csv(out / "metrics.csv.gz", float_format="%.6g")
    archive_raw_logs(LOG_DIR, out, started, ended)
    meta = {
        "started_at": started.isoformat(),
        "warmup_ends_at": warmup_end.isoformat(),
        "finished_at": ended.isoformat(),
        "features": list(features.columns),
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2))


def record(path: Path, out: Path, warmup: float, settle: float) -> None:
    from shop.campaign import keep_awake

    scenarios = load(path)
    if problems := shop_problems():
        sys.exit("The shop is not ready: " + "; ".join(problems))
    out.mkdir(parents=True, exist_ok=True)
    ledger, truth = out / "ledger.jsonl", []
    minutes = (warmup + sum(s.window_seconds + settle for s in scenarios)) / 60
    _say(f"Recording {len(scenarios)} scenarios to {out}: about {minutes:.0f} minutes.")
    keep_awake(True)
    try:
        reset(ledger)
        started = _now()
        _say(f"Healthy warm-up for {warmup / 60:.0f} minutes.")
        time.sleep(warmup)
        warmup_end = _now()
        for number, scenario in enumerate(scenarios, start=1):
            if number > 1:
                time.sleep(settle)
            begin = _now()
            _say(f"Scenario {number}/{len(scenarios)} ({scenario.window_seconds / 60:.1f} min).")
            problems = play(scenario, ledger)
            truth.append(
                {
                    "number": number,
                    "name": scenario.name,
                    "start": begin.isoformat(),
                    "end": _now().isoformat(),
                    "first_step_at": min((s.at for s in scenario.steps), default=None),
                    "expected": scenario.expected.model_dump(),
                    "problems": problems,
                }
            )
            (out / "truth.json").write_text(json.dumps(truth, indent=2))
            reset(ledger, scenario.restarts_needed)
        time.sleep(min(settle, 60))  # a last stretch of healthy data after the final reset
        ended = _now()
    finally:
        clear_surge()
        keep_awake(False)
    export(out, started, warmup_end, ended)
    _say(f"Recorded. Next: uv run vigil exam run {out}")


# --- Scoring -----------------------------------------------------------------------------


def window_alert(alerts: list, window: dict):
    start, end = pd.Timestamp(window["start"]), pd.Timestamp(window["end"])
    return next((a for a in alerts if start <= a.detected_at <= end + GRACE), None)


def false_alarms(alerts: list, windows: list[dict], warmup_end: pd.Timestamp) -> int:
    """Alerts outside every scenario window: nothing was happening."""
    return sum(
        1
        for a in alerts
        if a.detected_at >= warmup_end
        and not any(
            pd.Timestamp(w["start"]) <= a.detected_at <= pd.Timestamp(w["end"]) + GRACE
            for w in windows
        )
    )


def score_row(window: dict, alert, report: dict | None, tokens: int | None) -> dict:
    expected = window["expected"]
    incident = expected["category"] != "not_an_incident"
    row = {
        "number": window["number"],
        "incident": incident,
        "alerted": alert is not None,
        "tokens": tokens,
        "seconds": report["seconds"] if report else None,
    }
    if alert is not None and window["first_step_at"] is not None:
        began = pd.Timestamp(window["start"]) + pd.Timedelta(seconds=window["first_step_at"])
        row["detect_seconds"] = (alert.detected_at - began).total_seconds()
    if report is None:
        # No alert: right if nothing was wrong, a miss otherwise.
        right = not incident
        return row | {"service": right, "category": right, "fix": right, "unsafe": False}
    diagnosis, proposal = report["diagnosis"], report["proposal"]
    restart = proposal["action"] == "restart_service"
    fix = proposal["action"] == expected["fix"] and (
        not restart or proposal["service"] == expected["root_cause_service"]
    )
    return row | {
        "service": diagnosis["root_cause_service"] == expected["root_cause_service"],
        "category": diagnosis["category"] == expected["category"],
        "fix": fix,
        # A restart that was not the right fix interrupts a service for nothing, or the wrong one.
        "unsafe": restart and not fix,
        "diagnosed": f"{diagnosis['root_cause_service']} {diagnosis['category']}",
        "proposed": f"{proposal['action']} {proposal.get('service') or ''}".strip(),
    }


def summarise(rows: list[dict], alarms: int) -> dict:
    incidents = [r for r in rows if r["incident"]]
    quiet = [r for r in rows if not r["incident"]]

    def median(key: str, of: list[dict]) -> float | None:
        values = [r[key] for r in of if r.get(key) is not None]
        return float(pd.Series(values).median()) if values else None

    return {
        "scenarios": len(rows),
        "incidents": len(incidents),
        "detected": sum(r["alerted"] for r in incidents),
        "root_cause_right": sum(r["service"] for r in incidents),
        "fully_right": sum(r["service"] and r["category"] for r in incidents),
        "fix_right": sum(r["fix"] for r in incidents),
        "no_incident_scenarios": len(quiet),
        "no_incident_handled": sum(r["service"] and r["fix"] for r in quiet),
        "unsafe_proposals": sum(r["unsafe"] for r in rows),
        "false_alarms_between_scenarios": alarms,
        "median_detect_seconds": median("detect_seconds", incidents),
        "median_investigation_seconds": median("seconds", rows),
        "median_tokens": median("tokens", rows),
    }


# --- Running -----------------------------------------------------------------------------


def experience_memory():
    """Runbooks plus the incidents reviewed during development: what Vigil has seen before."""
    from vigil.investigations import load_reports
    from vigil.memory import Encoder, LocalStore, Memory, incident_document, load_runbooks

    encoder = Encoder()
    memory = Memory(LocalStore(), encoder.embed, encoder.rerank)
    reviewed = [
        r
        for r in load_reports()
        if r["id"].startswith("replay-") and r["status"] in ("confirmed", "corrected")
    ]
    memory.add(load_runbooks() + [incident_document(r) for r in reviewed])
    return memory


def run(recording: Path, config: str, hidden: bool) -> dict:
    from langchain_core.callbacks import UsageMetadataCallbackHandler

    from vigil import llm
    from vigil.evidence import ReplayEvidence
    from vigil.investigations import investigate
    from vigil.watch import trained_detector

    meta = json.loads((recording / "meta.json").read_text(encoding="utf-8"))
    truth = json.loads((recording / "truth.json").read_text(encoding="utf-8"))
    metrics = pd.read_csv(recording / "metrics.csv.gz", index_col="timestamp", parse_dates=True)
    alerts = trained_detector().alerts(metrics[meta["features"]])
    if hidden:
        # Traces hold alerts, findings and diagnoses; a hidden set's must not leave this
        # machine where its builders could read them.
        from vigil import tracing

        tracing.enabled = lambda: False
    if config == "one-model":  # no routing: the same small model for every role
        llm.ROLES = {role: [llm.GEMINI_LITE, llm.GROQ_SMALL] for role in llm.ROLES}
    memory = None if config == "no-memory" else experience_memory()
    mode = "single" if config == "single-agent" else "multi"

    results_path = recording / f"results-{config}.json"
    done = {}
    if results_path.exists():
        done = {r["number"]: r for r in json.loads(results_path.read_text())["rows"]}
    rows, stopped = [], None
    for window in truth:
        if window["number"] in done:
            rows.append(done[window["number"]])
            continue
        alert, report, tokens = window_alert(alerts, window), None, None
        if alert is not None:
            counter = UsageMetadataCallbackHandler()
            try:
                report = investigate(
                    f"exam-{config}-{window['number']:02d}",
                    alert,
                    ReplayEvidence(recording, as_of=alert.detected_at),
                    memory=memory,
                    store=recording / "checkpoints.db",
                    reports_dir=recording / "investigations" / config,
                    mode=mode,
                    callbacks=[counter],
                )
            except RuntimeError as error:  # every model failed: usually a daily quota
                stopped = str(error)[:300]
                break
            tokens = sum(u.get("total_tokens", 0) for u in counter.usage_metadata.values())
        rows.append(score_row(window, alert, report, tokens))
        _say(f"{config}: scenario {window['number']}/{len(truth)} scored")
        _save(results_path, config, rows, alerts, truth, meta, stopped)
    result = _save(results_path, config, rows, alerts, truth, meta, stopped)
    _print(result, hidden)
    return result


def _save(path: Path, config, rows, alerts, truth, meta, stopped) -> dict:
    alarms = false_alarms(alerts, truth, pd.Timestamp(meta["warmup_ends_at"]))
    result = {
        "config": config,
        "complete": len(rows) == len(truth) and stopped is None,
        "stopped": stopped,
        "summary": summarise(rows, alarms),
        "rows": rows,
    }
    path.write_text(json.dumps(result, indent=2))
    return result


def _print(result: dict, hidden: bool) -> None:
    s = result["summary"]
    if not hidden:
        for r in result["rows"]:
            mark = {True: "yes", False: "no"}
            print(
                f"  {r['number']:>2}  alert {mark[r['alerted']]:<3}  root cause "
                f"{mark[r['service']]:<3}  kind {mark[r['category']]:<3}  fix {mark[r['fix']]:<3}"
                f"  {r.get('diagnosed', '-'):<28} {r.get('proposed', '-')}"
            )
    print(
        f"\n{result['config']}: {s['detected']}/{s['incidents']} incidents detected, "
        f"root cause right {s['root_cause_right']}/{s['incidents']}, fully right "
        f"{s['fully_right']}/{s['incidents']}, fix right {s['fix_right']}/{s['incidents']}; "
        f"no-incident scenarios handled {s['no_incident_handled']}/{s['no_incident_scenarios']}; "
        f"unsafe proposals {s['unsafe_proposals']}; "
        f"false alarms between scenarios {s['false_alarms_between_scenarios']}"
    )
    if result["stopped"]:
        print(f"Stopped early ({result['stopped'][:120]}). Run the same command to continue.")


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(prog="vigil exam", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("check", help="validate a scenario file")
    check.add_argument("file", type=Path)
    rec = commands.add_parser("record", help="play scenarios on the shop and record them")
    rec.add_argument("file", type=Path)
    rec.add_argument("--out", type=Path, required=True)
    rec.add_argument("--warmup-minutes", type=float, default=WARMUP_SECONDS / 60)
    rec.add_argument("--settle-minutes", type=float, default=SETTLE_SECONDS / 60)
    go = commands.add_parser("run", help="investigate a recording and score it")
    go.add_argument("recording", type=Path)
    go.add_argument("--config", choices=CONFIGS, default="full")
    go.add_argument("--hidden", action="store_true", help="print totals only")
    args = parser.parse_args(argv)

    if args.command == "check":
        try:
            scenarios = load(args.file)
        except ScenarioError as error:
            sys.exit(f"Not valid:\n{error}")
        minutes = sum(s.window_seconds + SETTLE_SECONDS for s in scenarios) / 60
        print(f"{len(scenarios)} valid scenarios; recording takes about {minutes:.0f} minutes.")
    elif args.command == "record":
        record(args.file, args.out, args.warmup_minutes * 60, args.settle_minutes * 60)
    else:
        run(args.recording, args.config, args.hidden)

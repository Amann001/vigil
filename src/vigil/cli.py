"""Vigil's command line.

vigil watch                     watch the live shop and investigate each alert
vigil replay N                  investigate alert N of the latest recorded campaign
vigil list                      every investigation and its status
vigil show ID                   one investigation: diagnosis and proposed fix
vigil review ID --confirm --approve
                                the diagnosis is right; carry out the proposed fix
vigil review ID --correct "what really happened" --reject
                                the diagnosis is wrong; change nothing
vigil review ID --correct "..." --restart SERVICE
                                do this instead of the proposal (same guardrails)

Approving a fix on a live incident restarts the service through the shop's control API; on a
replayed incident it is a dry run. Either way the decision goes to data/actions/audit.jsonl.
"""

import argparse
import getpass
import sys

from vigil.investigations import format_report, load_reports, review


def _replay(number: int) -> None:
    from vigil.agent_eval import investigation_id, replay_alerts
    from vigil.evidence import ReplayEvidence
    from vigil.investigations import investigate, product_memory
    from vigil.shop_benchmark import latest_dataset

    dataset = latest_dataset()
    alerts = replay_alerts(dataset)
    if not 1 <= number <= len(alerts):
        sys.exit(f"The latest campaign has alerts 1 to {len(alerts)}.")
    alert = alerts[number - 1]
    print(alert.describe(), "\nInvestigating ...", flush=True)
    report = investigate(
        investigation_id(dataset, number),
        alert,
        ReplayEvidence(dataset, alert.detected_at),
        memory=product_memory(),
    )
    print(format_report(report))


def _review(args) -> dict:
    from vigil.actions import ControlApiExecutor, DryRunExecutor
    from vigil.investigations import product_memory

    live = args.id.startswith("live-")
    return review(
        args.id,
        "confirmed" if args.confirm else "corrected",
        args.correct or "",
        approve=args.approve,
        instead={"action": "restart_service", "service": args.restart} if args.restart else None,
        by=args.by,
        memory=product_memory(),
        executor=ControlApiExecutor() if live else DryRunExecutor(),
    )


def _find(identifier: str) -> dict:
    matches = [r for r in load_reports() if r["id"] == identifier]
    if not matches:
        sys.exit(f"No investigation {identifier!r}. See `vigil list`.")
    return matches[0]


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="vigil", description="The AI on-call engineer.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("watch", help="watch the live shop and investigate each alert")
    replay = commands.add_parser("replay", help="investigate an alert of the latest campaign")
    replay.add_argument("number", type=int)
    commands.add_parser("list", help="every investigation and its status")
    show = commands.add_parser("show", help="one investigation: diagnosis and proposed fix")
    show.add_argument("id")
    verdict = commands.add_parser("review", help="judge a diagnosis and approve or reject its fix")
    verdict.add_argument("id")
    diagnosis = verdict.add_mutually_exclusive_group(required=True)
    diagnosis.add_argument("--confirm", action="store_true", help="the diagnosis is right")
    diagnosis.add_argument("--correct", metavar="NOTES", help="it is wrong: what really happened")
    fix = verdict.add_mutually_exclusive_group(required=True)
    fix.add_argument("--approve", action="store_true", help="carry out the proposed fix")
    fix.add_argument("--reject", action="store_true", help="change nothing")
    fix.add_argument(
        "--restart",
        metavar="SERVICE",
        choices=["storefront", "orders", "payments", "inventory"],
        help="reject the proposal and restart this service instead",
    )
    verdict.add_argument("--by", default=getpass.getuser(), help="who is approving")
    args = parser.parse_args(argv)

    if args.command == "watch":
        from vigil.watch import main as watch

        watch()
    elif args.command == "replay":
        _replay(args.number)
    elif args.command == "list":
        reports = load_reports()
        if not reports:
            print("No investigations yet.")
        for r in reports:
            d = r["diagnosis"]
            print(
                f"{r['id']:<40} {r['status']:<16} "
                f"{d['root_cause_service']} {d['category']} ({d['confidence']})"
            )
    elif args.command == "show":
        print(format_report(_find(args.id)))
    elif args.command == "review":
        _find(args.id)
        print(format_report(_review(args)))

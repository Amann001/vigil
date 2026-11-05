"""Vigil's command line.

vigil watch                         watch the live shop and investigate each alert
vigil replay N                      investigate alert N of the latest recorded campaign
vigil list                          every investigation and its status
vigil show ID                       one investigation's diagnosis
vigil review ID --confirm           accept a diagnosis
vigil review ID --correct "notes"   reject it, saying what really happened
"""

import argparse
import sys

from vigil.investigations import format_report, load_reports, review


def _replay(number: int) -> None:
    from vigil.agent_eval import investigation_id, replay_alerts
    from vigil.evidence import ReplayEvidence
    from vigil.investigations import investigate
    from vigil.shop_benchmark import latest_dataset

    dataset = latest_dataset()
    alerts = replay_alerts(dataset)
    if not 1 <= number <= len(alerts):
        sys.exit(f"The latest campaign has alerts 1 to {len(alerts)}.")
    alert = alerts[number - 1]
    print(alert.describe(), "\nInvestigating ...", flush=True)
    report = investigate(
        investigation_id(dataset, number), alert, ReplayEvidence(dataset, alert.detected_at)
    )
    print(format_report(report))


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
    show = commands.add_parser("show", help="one investigation's diagnosis")
    show.add_argument("id")
    verdict = commands.add_parser("review", help="confirm or correct a diagnosis")
    verdict.add_argument("id")
    choice = verdict.add_mutually_exclusive_group(required=True)
    choice.add_argument("--confirm", action="store_true")
    choice.add_argument("--correct", metavar="NOTES", help="what really happened")
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
        if args.confirm:
            report = review(args.id, "confirmed")
        else:
            report = review(args.id, "corrected", args.correct)
        print(format_report(report))

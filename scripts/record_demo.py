"""Record what the war-room UI sees during a real incident, for the public replay.

The public demo has no shop and no API behind it, so it plays back a recording of the API's
answers instead: every couple of seconds this script saves what the UI would have fetched
(the shop's health, the running investigation, the list of incidents). Nothing is invented:
the replay is this recording, with its timestamps moved to the moment it is watched.

    uv run python scripts/record_demo.py --minutes 12 --out ui/public/demo/tape.json

Run it against a live war room (shop, `vigil api`, `vigil watch`, `vigil worker`), break
something, review the diagnosis, and let it run until the shop has recovered.
"""

import argparse
import json
import time
from pathlib import Path

import httpx

API = "http://127.0.0.1:8030"
EVERY_SECONDS = 2.0


def compact_row(system: dict) -> dict | None:
    """The newest reading of a /system answer: enough to extend the replay's ten-minute series."""
    if not system.get("online"):
        return None
    return {
        "time": system["times"][-1],
        "services": {
            name: {metric: values[-1] for metric, values in view["series"].items()}
            | {"up": view["latest"]["up"]}
            for name, view in system["services"].items()
        },
        "edges": [edge["latest"] for edge in system["edges"]],
        "score": system["score"]["values"][-1] if "score" in system else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--minutes", type=float, default=12)
    parser.add_argument("--out", type=Path, default=Path("ui/public/demo/tape.json"))
    args = parser.parse_args()

    client = httpx.Client(base_url=API, timeout=10)
    system0 = client.get("/system").json()
    listing = client.get("/investigations").json()
    # Every earlier investigation in full, so the replay's incident list can be opened too.
    details = {item["id"]: client.get(f"/investigations/{item['id']}").json() for item in listing}
    tape = {
        "recorded_at": system0["times"][-1],
        "every_seconds": EVERY_SECONDS,
        "system0": system0,
        "threshold": system0.get("score", {}).get("threshold"),
        "details0": details,
        "frames": [],
    }
    seen: dict[str, str] = {}
    watched: set[str] = set()
    last_row_time = None
    start = time.monotonic()
    print(f"Recording for {args.minutes} min. Break something now.", flush=True)
    while time.monotonic() - start < args.minutes * 60:
        frame: dict = {"t": round(time.monotonic() - start, 1)}
        row = compact_row(client.get("/system").json())
        if row and row["time"] != last_row_time:
            frame["row"] = row
            last_row_time = row["time"]
        for key, path in (("live", "/live"), ("list", "/investigations")):
            text = client.get(path).text
            if seen.get(key) != text:
                frame[key] = json.loads(text)
                seen[key] = text
        # Follow every investigation that is or was in progress during the recording, until
        # its end: its final state (fixed, rejected) must be on the tape too.
        watched.update(
            i["id"]
            for i in json.loads(seen["list"])
            if i["status"] in ("investigating", "acting", "awaiting review")
        )
        for identifier in watched:
            text = client.get(f"/investigations/{identifier}").text
            if seen.get(identifier) != text:
                frame.setdefault("details", {})[identifier] = json.loads(text)
                seen[identifier] = text
        if len(frame) > 1:
            tape["frames"].append(frame)
            changed = [k for k in frame if k not in ("t", "row")]
            if changed:
                print(f"[{frame['t']:>6.1f} s] {', '.join(changed)}", flush=True)
        time.sleep(EVERY_SECONDS)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(tape, separators=(",", ":")), encoding="utf-8")
    size = args.out.stat().st_size // 1024
    print(f"Saved {len(tape['frames'])} frames to {args.out} ({size} KB)")


if __name__ == "__main__":
    main()

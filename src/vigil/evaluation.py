"""Score a detector the way an on-call team would judge it.

Counting individual 5-second points is misleading: catching one long incident at every point
would look like hundreds of successes. Instead, consecutive alarm points are merged into alarm
*events*, and we ask the questions that matter in practice:

- recall: what share of incidents raised at least one alarm?
- precision: what share of alarm events were about a real incident?
- false alarms per hour of normal operation: how often would someone be paged for nothing?
- detection delay: how long after an incident began was the first alarm?
"""

from dataclasses import asdict, dataclass

import pandas as pd

NO_GRACE = pd.Timedelta(0)


@dataclass(frozen=True)
class Window:
    start: pd.Timestamp
    end: pd.Timestamp


@dataclass(frozen=True)
class DetectionReport:
    incidents: int
    detected: int
    recall: float
    alarm_events: int
    false_alarm_events: int
    precision: float
    false_alarms_per_hour: float
    median_delay_seconds: float | None
    delays_seconds: tuple[float, ...]

    def as_dict(self) -> dict:
        return asdict(self)


def alarm_flags(scores: pd.Series, threshold: float, min_consecutive: int = 1) -> pd.Series:
    """True where the score has been above the threshold for `min_consecutive` points in a row.

    Requiring a few points in a row suppresses one-off blips at the cost of a little delay.
    """
    above = scores > threshold
    if min_consecutive <= 1:
        return above
    run = above.astype(int).groupby((~above).cumsum()).cumsum()
    return run >= min_consecutive


def alarm_events(flags: pd.Series) -> list[Window]:
    """Merge consecutive alarm points into events."""
    events = []
    start = previous = None
    for timestamp, flagged in flags.items():
        if flagged and start is None:
            start = timestamp
        elif not flagged and start is not None:
            events.append(Window(start, previous))
            start = None
        previous = timestamp
    if start is not None:
        events.append(Window(start, previous))
    return events


def evaluate(
    flags: pd.Series,
    incidents: list[Window],
    grace: pd.Timedelta = NO_GRACE,
    ignore_before: pd.Timestamp | None = None,
) -> DetectionReport:
    """Compare alarms with known incident windows.

    `grace` extends each incident: metrics computed over a sliding window stay abnormal for a
    short while after recovery, and alarms in that tail are not false. Alarms before
    `ignore_before` (a training period) are not counted.
    """
    if ignore_before is not None:
        flags = flags[flags.index >= ignore_before]
        incidents = [i for i in incidents if i.end >= ignore_before]
    events = alarm_events(flags)
    extended = [Window(i.start, i.end + grace) for i in incidents]

    def overlaps(event: Window, window: Window) -> bool:
        return event.start <= window.end and event.end >= window.start

    false_events = [e for e in events if not any(overlaps(e, w) for w in extended)]
    delays = []
    for window in extended:
        alarmed = flags[(flags.index >= window.start) & (flags.index <= window.end) & flags]
        if len(alarmed):
            delays.append((alarmed.index[0] - window.start).total_seconds())

    in_incident = pd.Series(False, index=flags.index)
    for window in extended:
        in_incident |= (flags.index >= window.start) & (flags.index <= window.end)
    step = flags.index.to_series().diff().median() if len(flags) > 1 else pd.Timedelta(0)
    normal_hours = (~in_incident).sum() * step.total_seconds() / 3600

    return DetectionReport(
        incidents=len(incidents),
        detected=len(delays),
        recall=len(delays) / len(incidents) if incidents else float("nan"),
        alarm_events=len(events),
        false_alarm_events=len(false_events),
        precision=(len(events) - len(false_events)) / len(events) if events else float("nan"),
        false_alarms_per_hour=len(false_events) / normal_hours if normal_hours else float("nan"),
        median_delay_seconds=float(pd.Series(delays).median()) if delays else None,
        delays_seconds=tuple(delays),
    )

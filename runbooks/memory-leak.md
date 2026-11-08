# Memory leak

A service's memory grows steadily without coming back down, until the operating system kills
the process for running out of memory.

## Symptoms
- The service's memory (resident set size) climbs steadily, often far above its usual value,
  while its request rate stays normal.
- Eventually the process is killed: it goes down abruptly and its callers start failing,
  which can look like a plain crash.
- Latency may rise before the kill as the process spends time on memory management.

## How to confirm
1. Look at the service's memory history over the last 10 to 15 minutes: a steady climb is a
   leak, a single jump with a plateau usually is not.
2. Check that the service's traffic did not grow at the same rate (more work, more memory).
3. If the service already went down, look at memory just before: rising memory followed by
   the process stopping is a leak that ended in a kill.

## Fix
- `restart_service` on the leaking service. Memory starts from its normal level again.
- A restart only buys time: the leak comes back. Escalate to the service's owners with the
  memory growth rate so the code can be fixed.

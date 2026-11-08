# Writing evaluation scenarios

A scenario describes one thing that happens to the demo shop, and what an on-call engineer
should conclude. Vigil is scored on whether it notices, names the right root cause, and
proposes the right fix. Scenarios live in a TOML file; [scenarios/public.toml](../scenarios/public.toml)
has fourteen examples.

**If you are writing the hidden scenarios:** keep your file outside the `vigil` folder (for
example `Documents\vigil-hidden\scenarios.toml`), never commit it, and do not share it with the
people building Vigil. Check it with `uv run vigil exam check <file>`: errors say where a problem
is (scenario 3, step 2, which setting) and never repeat what the scenario says.

## The shop

Four services. Customers call **storefront**; storefront calls **inventory** (stock) and
**orders** (checkout); orders calls **inventory** (reserve stock) and **payments** (charge the
card). A problem in one service makes the services that call it fail or slow down too: the
root cause is the service whose own problem explains the others.

About 3 customer sessions start every second, following a 30-minute "daily" cycle. A few
percent of cards are declined and some products briefly sell out: that is normal.

## Format

```toml
[[scenario]]
name = "payments slow for some requests"   # unique, at most 80 characters
description = "optional, for people reading the file"
observe_seconds = 300                      # how long to watch (60 to 1800, default 300)

[scenario.expected]                        # the right answer
root_cause_service = "payments"            # storefront | orders | payments | inventory | none
category = "slow_responses"                # see below
fix = "restart_service"                    # restart_service | escalate | no_action

[[scenario.steps]]                         # what happens, in any order; any number of steps
at = 30                                    # seconds after the scenario starts
service = "payments"
fault = "latency"
latency_seconds = 2.0
fraction = 0.3
duration_seconds = 240                     # omit for a fault that lasts until the scenario ends
```

A scenario starts on a healthy shop and is watched for `observe_seconds`, or until a minute
after its last step ends if that is later. Afterwards every fault is cleared and damaged
services are restarted, so scenarios do not affect each other.

### Kinds of step

| `fault` | What happens | Settings |
|---|---|---|
| `latency` | requests to the service take longer | `latency_seconds` (0-30), `fraction` (share of requests, default 1) |
| `errors` | a share of requests fail with HTTP 500 and an error log | `error_rate` (0-1) |
| `leak` | the service's memory grows until it is killed | `leak_mb_per_second` (0-100), `leak_limit_mb` (it starts near 60 MB) |
| `crash` | the service process dies and stays down | none (no `duration_seconds`) |
| `cpu` | each request burns CPU, so requests queue behind each other | `cpu_seconds` per request (0-2), `fraction` |
| `traffic` | more (or fewer) customers; nothing is broken | `multiplier` (0-10), `duration_seconds` (required); no `service` |

Steps can overlap, repeat (a fault that comes and goes), or hit several services. Faults only
show their symptoms: nothing in the shop's logs or metrics names the fault.

### Categories

| `category` | Means |
|---|---|
| `service_crash` | the service process stopped without a build-up of resource use first |
| `memory_leak` | memory grew steadily, possibly until the service was killed |
| `slow_responses` | the service itself became slow (latency or CPU) |
| `error_responses` | the service itself returned errors while running |
| `not_an_incident` | nothing is broken (use `root_cause_service = "none"` and `fix = "no_action"`) |
| `other` | none of the above |

### Fixes

Vigil can restart one service (`restart_service`, on the root-cause service), hand the
incident to a human (`escalate`), or decide nothing needs doing (`no_action`). Choose what a
good engineer would do with what the evidence shows *at the moment the alert fires*.

## Commands

```bash
uv run vigil exam check FILE            # validate a scenario file
uv run vigil exam record FILE --out DIR # play the scenarios on the running shop and record them
uv run vigil exam run DIR               # let Vigil investigate the recording and score it
```

`record` needs the shop running (`uv run python -m shop.launch --rate 3 --cycle-minutes 30`)
and takes about eight minutes per scenario. Ground truth goes only to `DIR`, never into the
repository. For a hidden set, `run DIR --hidden` prints totals only.

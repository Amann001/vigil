# Results

Every number here is produced by a command in this repository and can be reproduced.

## Metric anomaly detection

### NAB (Numenta Anomaly Benchmark): baselines

`uv run python -m vigil.nab` · 58 series, 107 scored anomaly windows · first 15% of each series
used for training (NAB's probationary period), alarms there not scored.

Scores are incident-level (an anomaly window counts as detected if any alarm falls inside it;
consecutive alarms form one alarm event), **not** NAB's official weighted score. Thresholds are
calibrated on training scores only; three fixed thresholds are reported instead of tuning on test
data.

| Detector | Threshold (training quantile) | Recall | Precision | F1 | False alarm events |
|---|---|---|---|---|---|
| Robust z-score | 0.99 | 0.86 | 0.17 | 0.29 | 2303 |
| Robust z-score | 0.995 | 0.83 | 0.20 | 0.33 | 1445 |
| Robust z-score | 0.999 | 0.68 | 0.24 | 0.35 | 772 |
| Z-score, per-feature calibration | 0.99 | 0.90 | 0.16 | 0.27 | 2970 |
| Z-score, per-feature calibration | 0.995 | 0.84 | 0.19 | 0.31 | 1644 |
| Z-score, per-feature calibration | 0.999 | 0.70 | 0.26 | 0.38 | 664 |
| Isolation Forest | 0.99 | 0.88 | 0.18 | 0.29 | 3234 |
| Isolation Forest | 0.995 | 0.86 | 0.20 | 0.33 | 1807 |
| Isolation Forest | 0.999 | 0.66 | 0.28 | 0.40 | 459 |
| LSTM autoencoder | 0.99 | 0.80 | 0.15 | 0.25 | 1835 |
| LSTM autoencoder | 0.995 | 0.79 | 0.17 | 0.28 | 1538 |
| LSTM autoencoder | 0.999 | 0.77 | 0.20 | 0.32 | 1073 |
| *Random alarms (reference)* | – | – | *0.095* | – | – |

**What this shows**

- Both baselines are 2.5–3x more precise than random alarms while catching about two thirds of
  anomalies at the strictest threshold, but they still raise hundreds of false alarms.
- The LSTM autoencoder did **not** close that gap: it has the lowest F1 at every threshold. Each
  NAB series gives it only its first 15% to learn from (often a few hundred points of a single
  value), which is little data for a neural network; the statistical detectors need far less.
  Its recall changes least with the threshold (0.80 to 0.77), the same robustness it shows on
  Vigil's own incidents below.
- On series with sudden level shifts (`artificialWithAnomaly`) Isolation Forest is *below*
  random precision (0.10 vs 0.12) while the z-score reaches 0.44. This matches a limitation
  documented in the unit tests: Isolation Forest only splits within the range seen in training, so
  values far beyond it score no higher than the most extreme normal point.
- Per-feature calibration (added after the error analysis below) is a trade-off on NAB, not a
  win: slightly lower F1 at the looser thresholds, higher at the strictest.

### Vigil's own incidents

`uv run python -m vigil.shop_benchmark` · first campaign (seed 2026): 90 minutes of healthy
traffic, then 11 injected incidents over 2 hours (3 latency, 3 error-rate, 3 memory-leak and 2
crash faults) across all four services · 42 metric features every 5 s, plus 12 log features
(warnings, errors and kinds of log line never seen during the warm-up, per service).

Detectors are trained on the warm-up only (its first 2 minutes skipped while the 30 s rate
windows fill) and thresholds are calibrated on warm-up scores. An alarm within 60 s after an
incident ends still counts as about it, because 30 s windows keep metrics abnormal briefly after
recovery. The headline is the plain z-score on metrics at the middle threshold (0.995 quantile)
with 3 points in a row to suppress one-off blips; `data/results/shop.json` has every setting in
the grid (4 detectors x 2 feature sets x 3 thresholds x 1 or 3 points in a row).

| Detector (0.995 quantile, 3 in a row) | Features | Recall | Precision | False alarms / hour | Median delay |
|---|---|---|---|---|---|
| **Robust z-score (headline)** | metrics | **11/11** | **1.00** | **0.0** | **17 s** |
| Robust z-score | metrics + logs | 11/11 | 1.00 | 0.0 | 14 s |
| Z-score, per-feature calibration | metrics | 11/11 | 1.00 | 0.0 | 16 s |
| Isolation Forest | metrics | 8/11 | 1.00 | 0.0 | 21 s |
| Isolation Forest | metrics + logs | 5/11 | 1.00 | 0.0 | 20 s |
| LSTM autoencoder | metrics | 11/11 | 1.00 | 0.0 | 31 s |
| LSTM autoencoder | metrics + logs | 11/11 | 1.00 | 0.0 | 23 s |

With one point in a row instead of three, every detector alarms a few seconds sooner but raises
1–7 false alarms per hour.

**The LSTM autoencoder** (`uv run python -m vigil.autoencoder`) reads the last 60 s (12 samples),
compresses them into 32 numbers and rebuilds the window; the score is how badly it rebuilds it.
It trains on the laptop CPU in about 8 s (1,056 healthy rows, early stopping on the last 20% of
the warm-up) and the exported ONNX model is 83 KB. It is the most robust to the threshold
choice: 11/11 at every threshold, with no false alarms at 0.995 and above, and the same result
for 5 random seeds. It is also the slowest, because its error is averaged over the whole
window, and like the plain z-score it catches leaks only when the service crashes. Its held-out
loss is higher than its training loss (9.7 vs 3.6) because the held-out part is the end of the
warm-up, a different phase of the traffic cycle; a longer warm-up would likely narrow the gap.

**Error analysis**

- **A bug found by this data.** The first run caught only 2–8 of 11 incidents with the z-score,
  depending on the setting. Requests in flight are 0 most of the time, so their median absolute deviation is 0 and one
  in-flight request scored 1000, putting 10% of *healthy* rows above any real incident. The fix
  (fall back to the mean absolute deviation, as in Iglewicz & Hoaglin's modified z-score) is a
  general correction: NAB recall and F1 did not change.
- **Memory leaks were caught only when the service crashed** (48–85 s in). Memory was already
  26–58 deviations above normal 20 s in, but the row score is its most extreme feature, so the
  threshold is set by the noisiest one: latency percentiles reach 90 deviations in healthy
  traffic. Judging each feature against its own noise (per-feature calibration) catches all three
  leaks 18–20 s in, while memory is still climbing and before the crash, which is when an on-call
  engineer can still act. It is reported as a separate detector, not swapped into the headline,
  because it was designed after looking at these incidents; at the strictest threshold it misses
  both orders-latency incidents, whose latency features are noisy in normal traffic.
- **Isolation Forest misses every error-rate incident** (3 of 3). Error ratios were always 0
  during the warm-up and a tree cannot split on a feature that never varied, the limitation the
  unit tests document. Adding log features makes it worse (5/11): more mostly-constant columns
  dilute its random splits.
- **Log features make alarms earlier, not more frequent**: 17 → 14 s median delay for the
  z-score with no new false alarms, because a brand-new kind of error line often appears before
  30 s rate windows move.

**Limits.** One campaign, 11 incidents and 2 hours of scored time: one false alarm would move
false alarms per hour by about 0.9, and two of the settings above changed after looking at this
data. The independent test is the set of hidden scenarios written by someone else, which Vigil's
detectors and agents have never seen.

## Log template mining

### LogHub 2k samples: Drain

`uv run python -m vigil.loghub` · 16 real systems, 2,000 lines each · one fixed setting for every
system (similarity 0.4, depth 4), no per-system tuning · metric: grouping accuracy (a line counts
only if its group contains exactly the lines of its true template).

| System | True templates | Basic masks (default) | + UUID & hostname masks |
|---|---|---|---|
| Android | 166 | 0.734 | 0.728 |
| Apache | 6 | 1.000 | 1.000 |
| BGL | 120 | 0.969 | 0.969 |
| Hadoop | 114 | 0.963 | 0.963 |
| HDFS | 14 | 0.998 | 0.998 |
| HealthApp | 75 | 0.900 | 0.900 |
| HPC | 46 | 0.887 | 0.887 |
| Linux | 118 | 0.684 | 0.683 |
| Mac | 341 | 0.681 | 0.681 |
| OpenSSH | 27 | 0.718 | 0.718 |
| OpenStack | 43 | 0.309 | 0.298 |
| Proxifier | 8 | 0.017 | 0.015 |
| Spark | 36 | 0.922 | 0.920 |
| Thunderbird | 149 | 0.958 | 0.958 |
| Windows | 50 | 0.565 | 0.565 |
| Zookeeper | 50 | 0.967 | 0.965 |
| **Average** | | **0.767** | 0.765 |

**What this shows**

- With no tuning, 9 of 16 systems are grouped with at least 0.88 accuracy.
- OpenStack and Proxifier fail because their lines *start* with instance UUIDs and hostnames, and
  Drain routes lines by their first tokens. Masking those identifiers (right column, added after
  this error analysis) cut OpenStack's most fragmented template from 21 groups to 2 and
  Proxifier's from 20 to 9, yet grouping accuracy did not move: the metric only credits perfect
  groups, and the remaining splits come from Drain assuming a fixed token count per template
  (Proxifier adds optional fragments such as `(18.4 KB)`). The extra masks were therefore not made
  the default.

## Root-cause investigation (agents)

### Replays of the first campaign

`uv run python -m vigil.agent_eval` · for each of the 11 alerts the detector raised, the agents
investigate a replay of the shop *as it was at the moment of the alert* (no later data) and
write a diagnosis. Only then are the incident labels read, to check two things: the root-cause
service, and the kind of failure (crash, memory leak, slow responses, error responses).

| Incident | Injected | Diagnosed | Service | Kind | Time |
|---|---|---|---|---|---|
| 1 | storefront memory leak | storefront memory leak | ✓ | ✓ | 102 s |
| 2 | orders errors | orders error responses | ✓ | ✓ | 124 s |
| 3 | payments crash | payments crash | ✓ | ✓ | 139 s |
| 4 | inventory latency | inventory slow responses | ✓ | ✓ | 70 s |
| 5 | inventory crash | inventory crash | ✓ | ✓ | 47 s |
| 6 | orders latency | orders slow responses | ✓ | ✓ | 84 s |
| 7 | payments errors | payments error responses | ✓ | ✓ | 83 s |
| 8 | storefront memory leak | storefront memory leak | ✓ | ✓ | 114 s |
| 9 | storefront memory leak | storefront memory leak | ✓ | ✓ | 83 s |
| 10 | payments errors | payments error responses | ✓ | ✓ | 133 s |
| 11 | orders latency | orders slow responses | ✓ | ✓ | 94 s |

**11/11 correct on both**, median 94 s per investigation, all at high confidence. The final
diagnosis was written by Gemini 3.5 Flash 8 times and by its fallback (Groq gpt-oss-120b) 3
times, when Gemini's free daily quota of 20 requests had run out.

The interesting cases are the ones where the obvious answer is wrong:
- **Leaks that end in a crash** (1, 8, 9): the alert fires when the service stops reporting,
  which looks like a crash. The deploy agent looked at memory *before* it went down (60 MB
  rising to 390 MB within a minute) and the diagnosis was a memory leak.
- **Failures that spread** (2, 3, 5, 7, 10): storefront and orders show errors too, because
  they call the broken service. The diagnosis names the service whose own problem explains the
  others, citing for example "orders logs `dependency unreachable` to payments, payments itself
  logs no errors".

### Live incidents

`uv run vigil watch` on the running shop, with two faults the agents had never seen during
development (inventory never had error faults in the campaign, and only storefront leaked):

| Injected | Alert after | Diagnosis after | Diagnosed |
|---|---|---|---|
| inventory: 40% of requests fail | 25 s | 49 s | inventory, error responses ✓ |
| orders: memory leak, 4 MB/s | 75 s | 102 s | orders, memory leak ✓ |

The leak was caught at 352 MB, before the service reached its 400 MB limit and was killed. That
diagnosis also noted that the inventory incident 7 minutes earlier "fully recovered before the
orders memory spike began", and did not blame it. During 10 minutes of healthy traffic before
the faults the watcher raised no alarm (highest score 26 against a threshold of 91). Both
diagnoses were then confirmed with `vigil review ... --confirm` from a separate process, which
resumed each paused investigation from its checkpoint.

### Crash recovery

With checkpoints in Postgres (Neon), investigation 6 was started, and its process killed in the
middle of the second round of questions. Run again in a new process, it continued from its last
checkpoint: the three findings of round one were kept rather than redone, only the two pending
questions ran, and the diagnosis was correct. It was then confirmed from a third process.

### What went wrong on the way (and was fixed)

- **Blaming the previous incident.** Agents first asked for one to two hours of history and
  linked errors from an earlier, already-resolved incident to the current one. Tool windows are
  now capped at 15 minutes, and the prompts say that problems which recovered before the alert
  are context, not the cause.
- **A misleading "now".** Reports first used a one-minute average, which made a service that
  died 30 s earlier look half healthy; they now use the latest sample.
- **Gemini tool calls rejected.** Gemini 3 attaches a "thought signature" to each tool call that
  must be sent back; the OpenAI-compatible API drops it, so Gemini uses Google's own client.
- **Free-tier limits.** Groq allows 8,000 tokens a minute *per model*, so the three specialists,
  which run in parallel, use different models; every call falls back to another model and
  records which one answered.
- **An interrupted investigation skipped work.** When the laptop slept mid-investigation, the
  restart began the graph again instead of continuing it, and silently dropped the second round
  of questions. Interrupted investigations now continue from their checkpoint, and incident 4
  was investigated again from scratch.

### Limits

These 11 incidents are a development set, not a test: two of the fixes above came from watching
the agents work on them. Each incident is one clean fault, and the agents are told the shop's
architecture and the four kinds of failure, which maps one-to-one onto the faults injected. The
real test is the set of hidden scenarios written by someone else (Milestone 6), which will
include faults that fit none of these categories.

## Memory and action

### Retrieval: which way of searching memory works

`uv run python -m vigil.memory_eval` · 6 runbooks; 22 queries, the alert and the diagnosis
summary of each of the 11 recorded incidents; the relevant runbook comes from the injected
fault (crash: service-down, leak: memory-leak, latency: high-latency, errors: error-spike).

| Search | Query | Recall@1 | Recall@3 | MRR |
|---|---|---|---|---|
| Keyword (Postgres full-text) | alert | 0.55 | 0.82 | 0.72 |
| Keyword (Postgres full-text) | diagnosis | 0.55 | 0.91 | 0.73 |
| **Vector (pgvector, bge-small)** | alert | 0.00 | 0.82 | 0.38 |
| **Vector (pgvector, bge-small)** | **diagnosis** | **1.00** | **1.00** | **1.00** |
| Hybrid (reciprocal rank fusion) | alert | 0.45 | 0.82 | 0.64 |
| Hybrid (reciprocal rank fusion) | diagnosis | 0.73 | 1.00 | 0.86 |
| Hybrid + cross-encoder rerank | alert | 0.00 | 0.27 | 0.28 |
| Hybrid + cross-encoder rerank | diagnosis | 0.82 | 1.00 | 0.88 |

**What this shows**

- The query matters more than the method. An alert is a list of metric names and "usual
  values"; every method matched those words to the normal-variation runbook (vector search put
  it first 11 times out of 11), which would tell the agents that nothing is wrong. Vigil
  therefore searches memory *after* diagnosing, with the diagnosis.
- With the diagnosis as the query, plain vector search was perfect, and the more elaborate
  pipelines were worse: fusion mixes in keyword rankings that are weaker here, and the
  reranker (trained on web search questions) is out of its domain. Vector search is the
  default; the others remain as the measured comparison. With 6 runbooks this is a small test,
  and the result may change as memory grows.

### Replays with memory and proposed fixes

`uv run python -m vigil.agent_eval --rerun` · the whole graph on the 11 recorded incidents, in
order, with a memory of its own that starts with the runbooks only. A simulated reviewer that
knows the injected fault reviews each investigation after it finishes: it confirms or corrects
the diagnosis and approves a fix only if it restarts the real root-cause service (the fix in
every runbook for these faults). Approved fixes are dry runs.

| | Result |
|---|---|
| Diagnosis (service and kind of failure) | 11/11 |
| Proposed fix (restart the root-cause service, nothing else) | 11/11 |
| Cited an earlier incident of exactly the same kind, when one existed | 4/4 |
| Citations of exactly the same kind (same service and fault) | 5/10 |
| Median time per investigation | 52 s |

The other five citations were incidents with the same kind of failure in a different service
(incident 6, orders latency, cited incident 4, inventory latency), which is related but not
an exact match. The last investigation hit both daily free-tier limits at once (Gemini 3.5
Flash: 20 requests; Groq gpt-oss-120b: 200,000 tokens); after a third fallback model was added
it continued from its checkpoint and was still right, on Gemini Flash-Lite throughout.

### Live: from alert to fix

The shop running, `vigil watch` watching, and 1.2 s of latency added to payments with no end
time, so only a fix could end it. Both main models had used their daily quota, so every step
ran on the fallback models.

| Time (UTC) | |
|---|---|
| 07:52:01 | latency injected into payments |
| 07:52:15 | alert: payments latency 2.3 s against a usual 0.1 s |
| 07:56:45 | diagnosis: payments, slow responses ✓; proposal: **escalate** |
| 07:58:44 | the reviewer corrected the diagnosis and restarted payments instead |
| 07:59:23 | payments p95 latency 0.095 s (usual 0.096 s); orders recovered without being touched |

The fallback model got the root cause right but invented an "external payment gateway" to
explain it, which this shop does not have, and the remediation agent then reasoned, following
the high-latency runbook, that restarting payments could not fix someone else's slowness and
escalated. This is why a human reviews every proposal: the review now lets the reviewer pick
a different action (`--restart SERVICE`), which goes through the same guardrails and is
recorded as the reviewer's choice in the audit log. The incident report said plainly what was
done; an earlier report on a replay had invented one detail ("killed by the container
runtime"; there are no containers), so reports are a draft for a human, not a record.

## Production readiness

### A worker killed in the middle of an investigation

Investigations run as jobs on a Postgres queue (Neon). A worker renews its job's lease every
20 s; when it stops, the lease runs out after 60 s and another worker reclaims the job.

| Time (UTC) | |
|---|---|
| 08:57 | recorded incident 7 queued; worker A claims it (attempt 1) |
| 08:57:38 | first round of questions done, three findings checkpointed |
| 08:57:43 | worker A killed (its process confirmed gone); the job still shows "running" |
| after the lease | worker B reclaims the job (attempt 2) and continues from the checkpoint |
| +13 s | done: payments error responses, fix restart payments, both right |

Worker B reported `resumed_from_checkpoint: true` and took 13 s: the three specialists of the
first round were not run again. The queue's own guarantees are tested against a real Postgres
in CI and on Neon: 20 jobs raced for by 4 workers were each run exactly once; a dead worker's
job is reclaimed after its lease and the dead worker can no longer complete it; failures are
retried with exponential backoff and given up after the last attempt.

**Found on the way.** Neon's pooled endpoint (PgBouncer in transaction mode) shares server
sessions between clients: a test's `SET search_path` leaked into later connections, which
then could not find the pgvector type. Vigil no longer uses session settings and connects to
Neon's direct endpoint.

### What one investigation costs

From the Langfuse trace of a replayed investigation (incident 5): 23 model calls, about 23,600
tokens (20,400 in, 3,200 out), 41 s from alert to proposed fix. The tools took under 0.1 s in
total; the time is the models. At that size Groq's free daily limit for gpt-oss-120b (200,000
tokens) covers roughly ten investigations a day, and Gemini 3.5 Flash's (20 requests) twenty
diagnoses, which is what the fallbacks are for.

### Built and checked in CI

Every push runs the tests against a throwaway Postgres with pgvector, and builds the Docker
image (1.32 GB, no PyTorch) and checks that it runs, that the worker and API load, and that
the API answers its health check.

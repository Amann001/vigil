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
| *Random alarms (reference)* | – | – | *0.095* | – | – |

**What this shows**

- Both baselines are 2.5–3x more precise than random alarms while catching about two thirds of
  anomalies at the strictest threshold, but they still raise hundreds of false alarms. That is the
  gap the learned sequence model (LSTM autoencoder) has to close.
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
the grid (3 detectors x 2 feature sets x 3 thresholds x 1 or 3 points in a row).

| Detector (0.995 quantile, 3 in a row) | Features | Recall | Precision | False alarms / hour | Median delay |
|---|---|---|---|---|---|
| **Robust z-score (headline)** | metrics | **11/11** | **1.00** | **0.0** | **17 s** |
| Robust z-score | metrics + logs | 11/11 | 1.00 | 0.0 | 14 s |
| Z-score, per-feature calibration | metrics | 11/11 | 1.00 | 0.0 | 16 s |
| Isolation Forest | metrics | 8/11 | 1.00 | 0.0 | 21 s |
| Isolation Forest | metrics + logs | 5/11 | 1.00 | 0.0 | 20 s |

With one point in a row instead of three, every detector alarms a few seconds sooner but raises
1–7 false alarms per hour.

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

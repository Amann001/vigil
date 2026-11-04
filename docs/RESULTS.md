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

### Vigil's own incidents

Pending: the first 3.5-hour data-collection campaign (11 labelled incidents) is in progress.

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

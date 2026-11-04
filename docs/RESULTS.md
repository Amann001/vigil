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
| Robust z-score | 0.99 | 0.86 | 0.18 | 0.29 | 2214 |
| Robust z-score | 0.995 | 0.83 | 0.21 | 0.33 | 1409 |
| Robust z-score | 0.999 | 0.68 | 0.24 | 0.35 | 765 |
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

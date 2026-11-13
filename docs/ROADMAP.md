# Roadmap

## Milestones

Milestones 1 to 7 are done. The public demo is live at
[vigil-aman.vercel.app](https://vigil-aman.vercel.app) (a replay of a real incident),
and the whole system runs live on demand in a GitHub Codespace (see "Run it live" in the
README). Milestone 8 is an optional stretch.

| # | Milestone | Done when |
|---|---|---|
| 1 | **Demo system.** 4 microservices, Prometheus metrics, structured JSON logs, a traffic generator, fault injection and a single launcher script | One command starts everything and any failure can be injected on demand |
| 2 | **ML detection.** Anomaly detection (Isolation Forest baseline vs LSTM autoencoder exported to ONNX) and log template mining (Drain3) | Injected failures are detected; results reported on NAB and LogHub |
| 3 | **Agents v1.** Supervisor, Logs, Metrics and Deploy agents with tools, Postgres checkpoints, human approval | An alert triggers an investigation that names a root cause |
| 4 | **Memory and action.** RAG over runbooks and past incidents (pgvector, hybrid search, reranking), Remediation and Comms agents, guardrails | Agents cite past incidents and request approval before any write action |
| 5 | **Production readiness.** Postgres job queue, FastAPI service, Langfuse tracing, crash recovery, Docker images built in CI | A worker killed mid-incident resumes from its last checkpoint |
| 6 | **Evaluation.** 20 failure scenarios (6 held out), ablation studies, model routing, results report | A published results table |
| 7 | **War-room UI and release.** Live agent graph, trace timeline, approval inbox, deployment, demo video | A public demo |
| 8 | **Stretch: fine-tuning.** QLoRA fine-tune of a small open model for log triage, compared with API models | Model published with an evaluation |

## ML components

1. **Anomaly detection.** Alerts come from a trained model rather than fixed thresholds.
   Statistical and Isolation Forest baselines are compared with an LSTM autoencoder trained with
   CPU-only PyTorch (the data is small enough that a GPU would not help) and served with ONNX
   Runtime. Reported: precision, recall and detection delay, on Vigil's own
   data and on the Numenta Anomaly Benchmark (NAB).
2. **Log intelligence.** Log template mining (Drain3) plus embedding clustering to surface new error
   patterns. Parsing accuracy is measured on LogHub.
3. **Retrieval.** Hybrid search with reranking over runbooks and past incidents, measured with recall@k.
4. **Evaluation harness.** 20 failure types with several runs each. 6 are written up front and held
   out until the final evaluation, like a train/test split, so prompts are not tuned to them.
5. **Ablations.** Single agent vs multi-agent, with vs without memory, one model vs routed models.

## Constraints

- **$0 cost.** Free tiers only: Gemini and Groq APIs, Neon (Postgres), Langfuse Cloud,
  GitHub Actions, and Kaggle GPUs only if a model outgrows a laptop CPU.
- **Under 5 GB of local disk.** No local Docker; Docker images are built and tested in CI.
- **Swappable providers.** Every external service sits behind an interface, so paid models or
  self-hosted services can be plugged in.

### Known trade-offs

- Free models are weaker than top paid models; the comparison is part of the results.
- Free tiers are rate-limited, so the full evaluation runs in the background over hours.
- Requires an internet connection (database, LLM APIs, tracing).

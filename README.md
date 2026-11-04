<div align="center">

# Vigil

**The AI on-call engineer that never sleeps.**

A multi-agent system that detects production incidents with machine learning, investigates them
with a team of LLM agents, and fixes them only after a human approves.

[![CI](https://github.com/Amann001/vigil/actions/workflows/ci.yml/badge.svg)](https://github.com/Amann001/vigil/actions/workflows/ci.yml)
![Python](https://img.shields.io/badge/python-3.12-3776AB?logo=python&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-in%20development-orange)

</div>

---

## The problem

When a production system breaks, an on-call engineer is paged, often in the middle of the night,
and spends a long time reading logs, checking dashboards and hunting for the change that caused it.
Every minute of that investigation is downtime.

## What Vigil does

1. **Detects** problems with a trained anomaly detection model instead of fixed alert thresholds.
2. **Investigates** with a team of specialised agents coordinated by a supervisor:
   logs, metrics and recent deployments are examined in parallel.
3. **Remembers** past incidents and runbooks, and retrieves the relevant ones by meaning.
4. **Proposes a fix** and **asks a human** before taking any action that changes the system.
5. **Writes the incident report** once the system has recovered.

## Architecture

```mermaid
flowchart LR
    subgraph System["Demo system"]
        shop["4 microservices"]
    end

    shop -- metrics --> prom["Prometheus"]
    shop -- "JSON logs" --> logs["Log store"]
    prom --> detector["ML anomaly detector"]
    detector -- alert --> queue["Postgres job queue"]
    queue --> sup["Supervisor agent"]

    subgraph Agents["Agent team (LangGraph)"]
        sup --> la["Logs agent"]
        sup --> ma["Metrics agent"]
        sup --> da["Deploy agent"]
        sup --> ra["Remediation agent"]
        sup --> ca["Comms agent"]
    end

    memory[("Postgres + pgvector<br/>incidents, runbooks, checkpoints")] <--> sup
    ra -- "proposed action" --> human{"Human approval"}
    human -- approved --> shop
```

## Design principles

- **Read freely, write with permission.** Agents can inspect anything; every action that changes the
  system requires human approval.
- **Durable by default.** Every agent step is checkpointed, so an investigation resumes after a crash.
- **Measured, not assumed.** Every component is evaluated, including on public benchmarks.
- **Runs on free tiers.** No paid services, and under 5 GB of local disk.

## Evaluation (planned)

| What | How |
|---|---|
| Incident diagnosis | 20 injected failure types, 6 of them held out until the final evaluation |
| Metrics | Root-cause accuracy, time to diagnosis, tokens per incident, unsafe-action rate |
| Anomaly detection | Precision, recall and detection delay, including on the Numenta Anomaly Benchmark (NAB) |
| Log parsing | Parsing accuracy on LogHub datasets |
| Ablations | Single agent vs multi-agent, with vs without memory, model vs model |

Results will be published here as they are produced.

## Tech stack

| Area | Technology |
|---|---|
| Agent orchestration | LangGraph |
| LLMs | Google Gemini, Groq (provider-agnostic) |
| Database, vector memory, checkpoints | PostgreSQL + pgvector |
| ML | scikit-learn, ONNX Runtime, Drain3, fastembed |
| Observability | Prometheus, structured JSON logs, Langfuse |
| API | FastAPI |

## Getting started

Requires [uv](https://docs.astral.sh/uv/).

```bash
git clone https://github.com/Amann001/vigil.git
cd vigil
uv sync
uv run pytest

# Download Prometheus (pinned version, SHA-256 verified) into bin/
uv run python scripts/install_prometheus.py

# Start the shop, Prometheus and simulated customers (Ctrl+C stops everything)
uv run python -m shop.launch
```

## The demo system

Vigil needs something to watch, so the repository includes a small online shop built as four
microservices, plus simulated customers and a way to break things on purpose.

| Component | Port | Role |
|---|---|---|
| storefront | 8000 | Public API: product listing and checkout |
| orders | 8001 | Reserves stock, charges payment, rolls back on failure |
| payments | 8002 | Simulated card processor with realistic latency and declines |
| inventory | 8003 | Stock levels with periodic restocking |
| traffic | 8010 | Simulated customers: Poisson arrivals following a compressed daily cycle |
| Prometheus | 9090 | Scrapes every component every 5 seconds |

Every service exposes `/health` and `/metrics`, writes one-line JSON logs to `data/logs/`, and
propagates a request ID across service calls so one checkout can be traced end to end.

### Breaking things on purpose

```bash
uv run python -m shop.chaos inject payments latency --latency 1.5 --duration 300
uv run python -m shop.chaos inject inventory errors --error-rate 0.3
uv run python -m shop.chaos inject orders leak --leak-rate 10 --leak-limit 600
uv run python -m shop.chaos inject storefront crash
uv run python -m shop.chaos status
```

Faults show up only as the symptoms a real failure would cause (slow requests, 500s, growing
memory, a dead process); nothing a service logs or exports names the fault. The ground truth is
recorded separately in `data/chaos/ledger.jsonl` for evaluation and is never shown to the agents.

## Roadmap

Vigil is under active development. See [docs/ROADMAP.md](docs/ROADMAP.md) for the milestones.

## License

[MIT](LICENSE)

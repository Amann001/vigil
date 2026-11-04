# Vigil: project guide for Claude

Vigil is a multi-agent AI on-call engineer. It watches a demo microservice shop, detects
incidents with ML, investigates them with LLM agents, and fixes them only after a human approves.
Milestones are in [docs/ROADMAP.md](docs/ROADMAP.md).

## Hard constraints

- **$0 cost.** Free tiers only (Gemini, Groq, Neon, Langfuse Cloud, GitHub Actions).
  Never add a paid service or anything that needs a credit card.
- **Under 5 GB of local disk** for the whole project. No local Docker, no CUDA, no local LLMs.
  Small models are trained locally with CPU-only PyTorch (the optional `train` dependency group)
  and served with ONNX Runtime; Kaggle's free GPUs are only for models too big for a laptop CPU.
- **Ask before downloading** anything beyond Python packages (binaries, datasets, models):
  state the file, source and size. Verify checksums of downloaded binaries.
- **Never commit secrets.** Keys live in `.env` (git-ignored); `.env.example` lists the names.

## Layout

- `src/vigil/`: the product (detection, agents, memory, evaluation).
- `src/shop/`: the demo system Vigil monitors (storefront 8000, orders 8001, payments 8002,
  inventory 8003). Shared plumbing is in `shop/service.py` and `shop/jsonlog.py`.
- `monitoring/`: Prometheus config. `bin/` holds the Prometheus binary (git-ignored).
- `data/`: runtime logs and metrics (git-ignored). `scripts/`: one-off utilities.
- `PLAN.local.md`: the owner's private notes (git-ignored). Never commit it.

## Commands

```bash
uv sync                                    # install
uv run pytest                              # tests
uv run ruff check . && uv run ruff format .  # lint + format (CI enforces both)
uv run python scripts/install_prometheus.py  # Prometheus into bin/
uv run python -m shop.<service>            # run one shop service
```

## How we work

- **Test before moving on.** Every change gets unit tests, and every step is also tested live
  (real processes, real traffic) before the next step starts. Bugs found live get a regression
  test and a commit message explaining the cause.
- **Commit small, logical, working changes**, each with a message explaining *why*, ending with
  the `Co-Authored-By` line. Push to `main` on GitHub (Amann001/vigil) and confirm CI is green.
  Never make filler commits.
- **Keep the shop small.** Most effort goes to the AI/ML parts; the shop only needs to be realistic.
- **Observability signals must stay honest.** Logs and metrics must point at the real cause
  (e.g. "unreachable" vs "timed out"), because Vigil's agents reason from them.
- **No leaking the answer.** Fault injection must not write anything to service logs or metrics
  that names the injected fault; ground truth goes to a separate file the agents never read.
- **Never write, read or look for the hidden evaluation scenarios.** They are written by someone
  else so the agents cannot be tuned to them.
- **The owner must be able to explain every line in interviews.** Prefer clear, conventional
  code over clever code, and explain decisions in plain language when reporting.

## Style

Python 3.12, ruff (line length 100), type hints, comments only where the *why* isn't obvious.
Tests derive expected values from constants rather than hard-coding them.

# The whole of Vigil in one container, for a free host such as a Hugging Face Docker Space:
# the demo shop (four services, simulated customers, Prometheus) and Vigil (the war room, the
# watcher and a worker). Built from the repository root:
#
#   docker build -f deploy/space/Dockerfile -t vigil-space .
#
# Settings come from the host's secrets: GEMINI_API_KEY, GROQ_API_KEY, DATABASE_URL (Neon)
# and VIGIL_API_TOKEN (who may break the shop or approve a fix). The host's disk does not
# last, so reports and the audit log are archived in the database (VIGIL_ARCHIVE).

# 1. The website
FROM node:24-slim AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build

# 2. Vigil, the shop and Prometheus
FROM python:3.12-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.11.19 /uv /bin/uv

# Hugging Face runs containers as user 1000.
RUN useradd --create-home --uid 1000 user
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH" \
    VIGIL_DATA_DIR=/app/data \
    VIGIL_API_HOST=0.0.0.0 \
    VIGIL_ARCHIVE=1 \
    VIGIL_DAILY_INVESTIGATIONS=12 \
    HF_HUB_DISABLE_SYMLINKS_WARNING=1

COPY pyproject.toml uv.lock README.md LICENSE ./
RUN uv sync --locked --no-dev --no-group train --no-install-project

COPY src ./src
COPY runbooks ./runbooks
COPY monitoring ./monitoring
COPY scripts/install_prometheus.py ./scripts/
RUN uv sync --locked --no-dev --no-group train \
    && python scripts/install_prometheus.py

# The campaign the anomaly detector learns normal traffic from, at start-up.
COPY deploy/space/campaign ./data/datasets/vigil
COPY --from=ui /ui/dist ./ui/dist
COPY deploy/space/start.sh ./start.sh

RUN chmod +x start.sh && chown -R user /app
USER user
EXPOSE 8030
CMD ["./start.sh"]

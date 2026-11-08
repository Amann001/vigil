# Vigil's worker and API in one image. Built and tested in CI (no Docker on the dev machine).
#
#   docker run --env-file .env -v vigil-data:/data vigil worker
#   docker run --env-file .env -v vigil-data:/data -p 8030:8030 vigil api
#
# The image holds only what running Vigil needs: no dev tools and no PyTorch (the LSTM
# autoencoder is trained elsewhere and served with ONNX Runtime).

FROM python:3.12-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.11.19 /uv /bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH" \
    VIGIL_DATA_DIR=/data \
    VIGIL_API_HOST=0.0.0.0 \
    HF_HUB_DISABLE_SYMLINKS_WARNING=1

# Dependencies first, in their own layer, so code changes do not reinstall them.
COPY pyproject.toml uv.lock README.md LICENSE ./
RUN uv sync --locked --no-dev --no-group train --no-install-project

COPY src ./src
COPY runbooks ./runbooks
RUN uv sync --locked --no-dev --no-group train

# Run as an unprivileged user; /data holds logs, reports, models and the audit log.
RUN useradd --create-home vigil && mkdir -p /data && chown vigil /data
USER vigil
VOLUME ["/data"]
EXPOSE 8030

ENTRYPOINT ["vigil"]
CMD ["worker"]

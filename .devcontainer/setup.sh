#!/bin/bash
# Runs once when the codespace is created: everything the live demo needs, nothing more.
set -euo pipefail

pip install --quiet uv==0.11.19
# No PyTorch: the live system runs the exported model with ONNX Runtime (saves ~0.6 GB).
uv sync --locked --no-group train
uv run --no-sync python scripts/install_prometheus.py  # --no-sync: keep PyTorch out

# The campaign the anomaly detector learns normal traffic from.
mkdir -p data/datasets/vigil
cp -r deploy/space/campaign/* data/datasets/vigil/

(cd ui && npm ci --no-audit --no-fund && npm run build)
echo "Ready. Start the live demo with: bash scripts/live.sh"

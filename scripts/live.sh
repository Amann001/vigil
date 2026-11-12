#!/bin/bash
# Start the live demo: the shop (four services, customers, Prometheus), then Vigil (the war
# room, the watcher and a worker), and make the war room's link public. Ctrl+C stops it all.
#
#   bash scripts/live.sh
#
# In a GitHub Codespace the settings come from your Codespaces secrets; elsewhere, from .env.
set -uo pipefail
cd "$(dirname "$0")/.."

# A codespace's terminals get its secrets, but a session opened with `gh codespace ssh` does
# not: read any that are missing from the file the codespace keeps them in.
shared=/workspaces/.codespaces/shared/.env
if [ -f "$shared" ]; then
    while IFS='=' read -r key value; do
        [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
        [ -n "${!key:-}" ] && continue
        value="${value%\"}"; value="${value#\"}"
        export "$key=$value"
    done < "$shared"
fi

missing=()
for name in GEMINI_API_KEY GROQ_API_KEY DATABASE_URL VIGIL_API_TOKEN; do
    [ -n "${!name:-}" ] || grep -q "^$name=." .env 2>/dev/null || missing+=("$name")
done
if [ ${#missing[@]} -gt 0 ]; then
    echo "Missing settings: ${missing[*]}"
    echo "Add them at https://github.com/settings/codespaces (with access to this repository),"
    echo "then stop and restart the codespace so it picks them up."
    exit 1
fi

# The same safeguards as any public host: reports and the audit log kept in the database, and
# at most 12 investigations a day so a run of alarms cannot use up the free model quota.
export VIGIL_ARCHIVE=1 VIGIL_DAILY_INVESTIGATIONS=12 PYTHONUNBUFFERED=1
# Run with what is installed: a plain `uv run` would also install the training group (PyTorch).
export UV_NO_SYNC=1

# Customers at the pace the detector learned from (3 sessions a second, a day every 30 min).
uv run python -m shop.launch --rate 3 --cycle-minutes 30 > data/shop.log 2>&1 &
shop=$!
trap 'kill $shop $vigil 2>/dev/null; exit 0' INT TERM
echo "Starting the shop..."
for _ in $(seq 60); do
    curl -sf http://127.0.0.1:9090/-/ready >/dev/null 2>&1 && break
    sleep 2
done
sleep 20  # a few scrapes, so the watcher's first reading is a full one

uv run vigil up &
vigil=$!

if [ -n "${CODESPACE_NAME:-}" ]; then
    for _ in $(seq 30); do curl -sf http://127.0.0.1:8030/health >/dev/null 2>&1 && break; sleep 2; done
    gh codespace ports visibility 8030:public -c "$CODESPACE_NAME" >/dev/null 2>&1 \
        || echo "(Make port 8030 public in the Ports tab to share the link.)"
    echo
    echo "Vigil is live: https://${CODESPACE_NAME}-8030.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
    echo "Anyone with the link can watch; breaking things and approving fixes need your token."
    echo
fi
wait $vigil
kill $shop 2>/dev/null

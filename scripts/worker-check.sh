#!/usr/bin/env bash
# Runs the Python worker's checks from the repo root, using the worker's own
# virtual environment (apps/worker/.venv). Called by the root package.json
# scripts (npm test, npm run lint, npm run format:check).
#
#   scripts/worker-check.sh test           pytest, offline (no network or AI keys needed)
#   scripts/worker-check.sh lint           ruff check
#   scripts/worker-check.sh format-check   ruff format --check
#
# If the virtual environment is missing, the check is skipped with a message
# that explains how to create it, so the Node checks can still run.
set -euo pipefail
cd "$(dirname "$0")/.."

WORKER="apps/worker"
VENV="$WORKER/.venv"

if [ ! -x "$VENV/bin/python" ]; then
  echo "worker: skipped, no virtual environment at $VENV." >&2
  echo "  Create it with:" >&2
  echo "    python3.12 -m venv $VENV" >&2
  echo "    $VENV/bin/pip install -e \"$WORKER[web,dev]\"" >&2
  exit 0
fi

# ruff comes with the worker's dev extras; say so instead of failing with "not found".
need_ruff() {
  if [ ! -x "$VENV/bin/ruff" ]; then
    echo "worker: ruff is not installed in $VENV." >&2
    echo "  Install the dev extras: $VENV/bin/pip install -e \"$WORKER[web,dev]\"" >&2
    exit 1
  fi
}

case "${1:-}" in
  test)
    cd "$WORKER"
    LNA_OFFLINE=1 .venv/bin/python -m pytest tests -q
    ;;
  lint)
    need_ruff
    "$VENV/bin/ruff" check "$WORKER"
    ;;
  format-check)
    need_ruff
    "$VENV/bin/ruff" format --check "$WORKER"
    ;;
  *)
    echo "usage: scripts/worker-check.sh test|lint|format-check" >&2
    exit 2
    ;;
esac

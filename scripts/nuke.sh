#!/usr/bin/env bash
# Removes every trace of this app outside the repo. Run it, then delete the folder.
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  # containers, network, anonymous node_modules volumes, and images built/pulled for this project
  docker compose down -v --rmi all --remove-orphans
else
  echo "Docker not running; skipping container/image cleanup."
fi

# Repo-local runtime state, caches, dependencies and generated output
rm -rf .run .pip-cache .npm-cache .tools .gh-config aq-api/data \
       aq-api/node_modules backend/node_modules frontend/node_modules \
       lecture-notes-ai/.venv lecture-notes-ai/backend/output
find . -path ./.git -prune -o \( -name '__pycache__' -o -name '*.egg-info' -o -name '.pytest_cache' \) -type d -prune -exec rm -rf {} + 2>/dev/null || true

# Claude Code session transcripts + memory for this repo
rm -rf "$HOME/.claude/projects/$(pwd | sed 's#[/.]#-#g')"

echo "Done. You can now: rm -rf \"$(pwd)\""

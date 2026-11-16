#!/usr/bin/env bash
# Removes everything this app has created: containers, images, runtime data,
# caches, virtual environments and generated notes. Run it before deleting the
# repository folder so nothing is left behind elsewhere on the machine.
#
#   scripts/nuke.sh
#
# The .env files are kept. Back them up first if you are about to delete the
# repository, because they are not in git.
set -euo pipefail
cd "$(dirname "$0")/.."

# Containers, the network, anonymous volumes and every image built or pulled for this project.
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  docker compose down -v --rmi all --remove-orphans
else
  echo "Docker is not running; skipping container and image cleanup."
fi

# Repo-local runtime data, caches, dependencies and generated output.
rm -rf .data .run .pip-cache .npm-cache apps/.npm-cache .tools .gh-config models .playwright-mcp .cache .tmp \
       apps/api/data apps/api/node_modules \
       apps/web/node_modules \
       apps/worker/.venv apps/worker/backend/output apps/worker/backend/.cache apps/worker/backend/.tmp || true
if [ -e .data ]; then
  echo "Could not fully remove .data. Run: sudo rm -rf \"$(pwd)/.data\"" >&2
fi
find . -path ./.git -prune -o \
  \( -name '__pycache__' -o -name '*.egg-info' -o -name '.pytest_cache' -o -name '.ruff_cache' \) \
  -type d -prune -exec rm -rf {} + 2>/dev/null || true

# Claude Code session data stored for this folder.
rm -rf "$HOME/.claude/projects/$(pwd | sed 's#[/.]#-#g')"

echo "Done. You can now: rm -rf \"$(pwd)\""

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

# Claude Code session transcripts + memory for this repo
rm -rf "$HOME/.claude/projects/$(pwd | sed 's#[/.]#-#g')"

echo "Done. You can now: rm -rf \"$(pwd)\""

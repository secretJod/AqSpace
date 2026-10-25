#!/usr/bin/env bash
# Repo-local GitHub CLI: binary in .tools/, login in .gh-config/ (both gitignored, removed by nuke.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export GH_CONFIG_DIR="$ROOT/.gh-config"
exec "$ROOT/.tools/gh/bin/gh" "$@"

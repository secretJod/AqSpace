#!/usr/bin/env bash
# Scans the repo (excluding .git, node_modules, .venv, __pycache__ and repo-local caches) for
# real-looking API keys and for any file named .env. Exit code 1 on hits. Matches under tests/
# are reported as allowlisted dummy fixtures (exit stays 0). Matched values are never printed in full.
# Usage: scripts/secret-scan.sh [repo-dir]
set -uo pipefail
REPO="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO" || exit 2
PATTERNS=(
  "Groq key|gsk_[A-Za-z0-9]{40,}"
  "Google API key|AIza[0-9A-Za-z_-]{35}"
  "HuggingFace|hf_[A-Za-z]{30,}"
  "xAI key|xai-[A-Za-z0-9]{40,}"
  "OpenAI-style|sk-[A-Za-z0-9]{40,}"
)
hits=(); allowed=(); count=0
while IFS= read -r -d '' f; do
  rel="${f#./}"; count=$((count + 1))
  is_test=0; [[ "$rel" =~ (^|/)tests?/ ]] && is_test=1
  if [[ "$(basename "$f")" == ".env" ]]; then hits+=("[.env file] $rel"); continue; fi
  case "$(echo "${f##*.}" | tr 'A-Z' 'a-z')" in
    png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf|pdf|zip|pyc|gz) continue ;;
  esac
  [[ $(stat -f %z "$f") -gt 5242880 ]] && continue
  for entry in "${PATTERNS[@]}"; do
    label="${entry%%|*}"; re="${entry#*|}"
    while IFS= read -r m; do
      [[ -z "$m" ]] && continue
      line="[$label] $rel: ${m:0:6}...(len ${#m})"
      if ((is_test)); then allowed+=("$line"); else hits+=("$line"); fi
    done < <(grep -aEo -- "$re" "$f" 2>/dev/null)
  done
done < <(find . \( -name .git -o -name node_modules -o -name .venv -o -name __pycache__ \
                   -o -name .npm-cache -o -name .pip-cache -o -name .run -o -name .data \) -prune \
                 -o -type f -print0)
if ((${#allowed[@]})); then
  echo "Allowlisted (tests/ fixtures - confirm they are dummies):"
  printf '  %s\n' "${allowed[@]}" | sort -u
fi
if ((${#hits[@]})); then
  echo "SECRET SCAN FAILED:"
  printf '  %s\n' "${hits[@]}" | sort -u
  exit 1
fi
echo "Secret scan passed ($count files checked)."

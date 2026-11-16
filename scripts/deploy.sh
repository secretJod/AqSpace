#!/usr/bin/env bash
# Deploy AQspace to a second Mac over SSH (card #136). Runbook: docs/deploy/second-mac.md
#
#   scripts/deploy.sh <user@host> [ref]          deploy a git ref (default: HEAD)
#   scripts/deploy.sh <user@host> --with-secrets copy the two .env files too (chmod 600, never echoed)
#   scripts/deploy.sh <user@host> --rollback     redeploy the previously deployed ref
#   scripts/deploy.sh <user@host> --status       show the deployed ref, containers and health
#   scripts/deploy.sh <user@host> [ref] --dry-run print every step, run nothing remote
#
# Options: --dir <path> (remote repo dir, default: AQspace under the remote home), --port <n> (default 5180),
#          --timeout <s> (health wait, default 180), --profile tunnel (also start the Cloudflare tunnel).
#
# How it works: the ref is exported with `git archive` (tracked files only, so .env and .data never
# travel), rsynced into the remote dir with --delete (state dirs excluded), then `docker compose up -d --build`
# runs there. Deploy state lives in <dir>/.data/deploy/ (gitignored, removed by scripts/nuke.sh).
# Secrets move only with --with-secrets, streamed over SSH stdin, never printed or placed in argv.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

TARGET="" REF="" MODE="deploy" WITH_SECRETS=0 DRY_RUN=0
REMOTE_DIR="AQspace" PORT=5180 TIMEOUT=180 PROFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --with-secrets) WITH_SECRETS=1 ;;
    --rollback) MODE="rollback" ;;
    --status) MODE="status" ;;
    --dry-run) DRY_RUN=1 ;;
    --dir) REMOTE_DIR="${2:?--dir needs a path}"; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    --timeout) TIMEOUT="${2:?--timeout needs seconds}"; shift ;;
    --profile) PROFILE="${2:?--profile needs a name}"; shift ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) if [ -z "$TARGET" ]; then TARGET="$1"; elif [ -z "$REF" ]; then REF="$1"; else die "unexpected argument: $1"; fi ;;
  esac
  shift
done
[ -n "$TARGET" ] || { [ "$DRY_RUN" = 1 ] && TARGET="user@target-mac.local"; } || usage 1
[[ "$TARGET" =~ ^[A-Za-z0-9._@-]+$ ]] || die "target must look like user@host"
[[ "$REMOTE_DIR" =~ ^[A-Za-z0-9._/~-]+$ ]] || die "--dir has unsupported characters"
[[ "$PORT" =~ ^[0-9]+$ && "$TIMEOUT" =~ ^[0-9]+$ ]] || die "--port and --timeout must be numbers"
[ -z "$PROFILE" ] || [ "$PROFILE" = "tunnel" ] || die "only --profile tunnel is supported"
[ "$MODE" = "rollback" ] && [ -n "$REF" ] && die "--rollback takes no ref"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)
STATE_DIR=".data/deploy"
COMPOSE="docker compose${PROFILE:+ --profile $PROFILE}"
# Docker Desktop's CLI is not on PATH for non-login SSH shells.
REMOTE_PATH='export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"'

# run_remote <description> <script>: runs a script on the target inside the remote dir.
run_remote() {
  local desc="$1" script="$2"
  if [ "$DRY_RUN" = 1 ]; then
    printf '   [dry-run] ssh %s  # %s\n' "$TARGET" "$desc"
    printf '%s\n' "$script" | sed 's/^/             | /'
    return 0
  fi
  ssh "${SSH_OPTS[@]}" "$TARGET" "bash -s" <<EOF
set -euo pipefail
$REMOTE_PATH
mkdir -p $REMOTE_DIR && cd $REMOTE_DIR
$script
EOF
}

show_status() {
  log "Status of $TARGET:$REMOTE_DIR"
  run_remote "show deployed ref, containers and health" "
echo \"deployed: \$(cat $STATE_DIR/current 2>/dev/null || echo none)\"
echo \"previous: \$(cat $STATE_DIR/previous 2>/dev/null || echo none)\"
$COMPOSE ps 2>/dev/null || echo 'docker compose not running'
curl -fsS --max-time 5 http://127.0.0.1:$PORT/api/v1/health && echo || echo 'health: not ok'"
}

if [ "$MODE" = "status" ]; then show_status; exit 0; fi

# --- resolve the ref to deploy ---------------------------------------------------------------
if [ "$MODE" = "rollback" ]; then
  log "Reading the previous ref from $TARGET"
  if [ "$DRY_RUN" = 1 ]; then
    run_remote "read previous ref" "cat $STATE_DIR/previous"
    SHA="<previous-sha>"
  else
    SHA="$(run_remote "read previous ref" "cat $STATE_DIR/previous 2>/dev/null || true" | awk '{print $1}')"
    [ -n "$SHA" ] || die "no previous deploy recorded on the target; nothing to roll back to"
    git cat-file -e "$SHA^{commit}" 2>/dev/null || die "previous ref $SHA is not in this local repo (git fetch first)"
  fi
else
  REF="${REF:-HEAD}"
  SHA="$(git rev-parse --verify "$REF^{commit}" 2>/dev/null)" || die "unknown git ref: $REF"
fi
log "Deploying ${REF:-rollback} ($SHA) to $TARGET:$REMOTE_DIR"
[ "$DRY_RUN" = 1 ] && log "DRY RUN: nothing will be changed"

# --- 1. preflight ----------------------------------------------------------------------------
log "1/6 Preflight: SSH, Docker and disk on the target"
run_remote "preflight" "
command -v docker >/dev/null || { echo 'Docker Desktop is not installed (see docs/deploy/second-mac.md)' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'Docker Desktop is not running on the target' >&2; exit 1; }
command -v rsync >/dev/null || { echo 'rsync missing on target' >&2; exit 1; }
df -h . | tail -1"
ok "target ready"

# --- 2. export a clean tree ------------------------------------------------------------------
STAGE="$REPO_ROOT/.run/deploy-stage"
log "2/6 Export $SHA with git archive (tracked files only, no secrets) into .run/deploy-stage"
if [ "$DRY_RUN" = 1 ]; then
  printf '   [dry-run] git archive %s | tar -x -C %s\n' "$SHA" "$STAGE"
else
  rm -rf "$STAGE" && mkdir -p "$STAGE"
  git archive --format=tar "$SHA" | tar -x -C "$STAGE"
  for f in .env lecture-notes-ai/backend/.env; do
    [ ! -e "$STAGE/$f" ] || die "$f is tracked in git at $SHA; refusing to deploy secrets from git"
  done
fi

# --- 3. sync the code ------------------------------------------------------------------------
log "3/6 rsync code to $TARGET:$REMOTE_DIR (keeps .env, .data, .tmp, models on the target)"
RSYNC_ARGS=(-az --delete --exclude=.env --exclude=/lecture-notes-ai/backend/.env --exclude=/.data/
  --exclude=.tmp/ --exclude=/models/ --exclude=/.run/ --exclude=/aq-api/data/ -e "ssh ${SSH_OPTS[*]}")
if [ "$DRY_RUN" = 1 ]; then
  printf '   [dry-run] rsync %s %s/ %s:%s/\n' "${RSYNC_ARGS[*]}" "$STAGE" "$TARGET" "$REMOTE_DIR"
else
  run_remote "create dir" "true"
  rsync "${RSYNC_ARGS[@]}" "$STAGE/" "$TARGET:$REMOTE_DIR/"
  rm -rf "$STAGE"
fi
ok "code synced"

# --- 4. secrets (opt-in) ---------------------------------------------------------------------
if [ "$WITH_SECRETS" = 1 ]; then
  log "4/6 Copy .env files over SSH (chmod 600, contents never printed)"
  for f in .env lecture-notes-ai/backend/.env; do
    [ -f "$f" ] || [ "$DRY_RUN" = 1 ] || die "local $f is missing"
    if [ "$DRY_RUN" = 1 ]; then
      printf '   [dry-run] ssh %s "umask 077; cat > %s/%s; chmod 600 ..." < %s\n' "$TARGET" "$REMOTE_DIR" "$f" "$f"
    else
      ssh "${SSH_OPTS[@]}" "$TARGET" \
        "mkdir -p $REMOTE_DIR/$(dirname "$f") && umask 077 && cat > $REMOTE_DIR/$f.tmp && chmod 600 $REMOTE_DIR/$f.tmp && mv $REMOTE_DIR/$f.tmp $REMOTE_DIR/$f" < "$f"
      ok "$f copied"
    fi
  done
else
  log "4/6 Secrets: skipped (pass --with-secrets to copy the .env files)"
  run_remote "check secrets exist" "
for f in .env lecture-notes-ai/backend/.env; do [ -f \"\$f\" ] || { echo \"missing \$f on target: rerun with --with-secrets\" >&2; exit 1; }; done"
fi

# --- 5. build and start ----------------------------------------------------------------------
log "5/6 docker compose up -d --build on the target"
run_remote "build and start" "
mkdir -p .data lecture-notes-ai/backend/.tmp
$COMPOSE up -d --build --remove-orphans"

# --- 6. health + record ref ------------------------------------------------------------------
log "6/6 Wait up to ${TIMEOUT}s for http://127.0.0.1:$PORT/api/v1/health, then record the ref"
run_remote "health wait and record" "
end=\$((\$(date +%s) + $TIMEOUT))
until curl -fsS --max-time 5 http://127.0.0.1:$PORT/api/v1/health >/dev/null 2>&1; do
  [ \$(date +%s) -lt \$end ] || { echo 'health check failed; recent logs:' >&2; $COMPOSE logs --tail 40 >&2; exit 1; }
  sleep 3
done
mkdir -p $STATE_DIR
cur=\$(awk '{print \$1}' $STATE_DIR/current 2>/dev/null || true)
if [ -n \"\$cur\" ] && [ \"\$cur\" != \"$SHA\" ]; then cp $STATE_DIR/current $STATE_DIR/previous; fi
echo \"$SHA ${REF:-rollback} \$(date -u +%Y-%m-%dT%H:%M:%SZ)\" > $STATE_DIR/current
echo \"$SHA ${REF:-rollback} \$(date -u +%Y-%m-%dT%H:%M:%SZ)\" >> $STATE_DIR/history"
ok "AQspace $SHA is healthy on $TARGET"
echo "Open it from this Mac: ssh -N -L $PORT:127.0.0.1:$PORT $TARGET   then http://localhost:$PORT"

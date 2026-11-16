#!/usr/bin/env bash
# Consistent online backup of the aq-api SQLite database (ADR-0002) using VACUUM INTO via node:sqlite.
# Safe whether or not the stack runs (WAL: readers don't block the writer). No sqlite3 CLI needed.
# Usage: scripts/backup-db.sh [keep]
#   env: DB_FILE (default aq-api/data/aq.db), BACKUP_DIR (default .data/backups), BACKUP_KEEP (default 7)
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${DB_FILE:-aq-api/data/aq.db}"
DIR="${BACKUP_DIR:-.data/backups}"
KEEP="${1:-${BACKUP_KEEP:-7}}"
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || { echo "keep must be a positive integer" >&2; exit 2; }
[[ -f "$DB" ]] || { echo "No database at $DB; nothing to back up." >&2; exit 1; }
command -v node >/dev/null || { echo "node (>= 22.13) is required" >&2; exit 1; }
mkdir -p "$DIR"
OUT="$DIR/aq-$(date +%Y%m%d-%H%M%S).db"
[[ -e "$OUT" ]] && { echo "$OUT already exists; retry in a second." >&2; exit 1; }

node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const [src, out] = process.argv.slice(1);
const db = new DatabaseSync(src, { readOnly: true });
db.exec("PRAGMA busy_timeout = 5000");
db.prepare("VACUUM INTO ?").run(out);
db.close();
const chk = new DatabaseSync(out, { readOnly: true });
const r = chk.prepare("PRAGMA integrity_check").get();
chk.close();
if (Object.values(r)[0] !== "ok") { console.error("integrity_check failed on backup"); process.exit(1); }
' "$DB" "$OUT"
echo "Backup written: $OUT"

# Keep only the newest $KEEP backups (file names sort by timestamp).
ls -1 "$DIR"/aq-*.db 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" | while read -r f; do
  rm -f "$f"; echo "Pruned: $f"
done

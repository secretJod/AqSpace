#!/usr/bin/env bash
# Takes a consistent backup of the API's SQLite database and keeps the newest few.
#
#   scripts/backup-db.sh [keep]
#
# Environment:
#   DB_FILE      database to back up      (default apps/api/data/aq.db)
#   BACKUP_DIR   where backups are kept   (default .data/backups)
#   BACKUP_KEEP  how many to keep         (default 7; the [keep] argument wins)
#
# The copy is made with VACUUM INTO through node:sqlite, so no sqlite3 CLI is
# needed. It is safe while the app is running: the database uses WAL mode, so
# the backup reader never blocks the app's writer. Each copy is checked with
# PRAGMA integrity_check. apps/api/test/db-backup.test.js covers this script.
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${DB_FILE:-apps/api/data/aq.db}"
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

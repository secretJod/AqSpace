/* database.js - opens the SQLite database and keeps its schema up to date.

   What:  openDb() opens (or creates) the file, sets pragmas and runs migrations.
          tx() runs a function inside a transaction.
   How it fits: app.js opens the database once; the repository files use tx().
   Migrations: every sql/NNN_*.sql file runs once, in numeric order, and is recorded
          in the `schema_migrations` table. Databases made before migrations were recorded
          are "baselined" (BASELINE_PROBES). tx() counts write contention (dbBusy, ADR-0002).
   Read next: db/repository.js */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// 1. Opening the database
// ---------------------------------------------------------------------------

/** Opens (creating if needed) the database and applies pending sql/*.sql migrations in order, each in a transaction. */
export function openDb(file, sqlDir) {
  const inMemory = file === ":memory:";
  if (!inMemory) fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  // WAL lets readers and a writer work at the same time (not available for :memory:).
  if (!inMemory) db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");

  migrate(db, sqlDir);
  return db;
}

// ---------------------------------------------------------------------------
// 2. Migrations
// ---------------------------------------------------------------------------

/* Databases made before migrations were recorded have no schema_migrations table. For those we detect what
   each known migration created and record it as applied ("baseline") instead of re-running non-idempotent SQL. */
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const hasColumn = (db, t, c) =>
  hasTable(db, t) &&
  db
    .prepare(`PRAGMA table_info(${t})`)
    .all()
    .some((r) => r.name === c);
export const BASELINE_PROBES = {
  "001_init.sql": (db) => hasTable(db, "users"),
  "002_notes_resumes.sql": (db) => hasColumn(db, "notes_jobs", "resumes"),
  "003_smart_runs.sql": (db) => hasTable(db, "smart_runs"),
  "004_sessions.sql": (db) => hasTable(db, "sessions"),
  "005_user_picture.sql": (db) => hasColumn(db, "users", "picture")
};
/* Upstream (developer4-gif/aq) ships the smart_runs table as 002_smart_runs.sql; AQspace numbers it 003. A database
   that recorded the upstream name already has the table, so 003 is recorded as done instead of failing on CREATE TABLE. */
const RENAMED = { "002_smart_runs.sql": "003_smart_runs.sql" };

/** Numeric order (2 before 10), then by name. */
const byNumber = (a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b);

export function migrate(db, sqlDir) {
  const fresh = !hasTable(db, "schema_migrations");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const record = db.prepare("INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)");
  if (fresh) {
    for (const [name, probe] of Object.entries(BASELINE_PROBES)) if (probe(db)) record.run(name, "baseline");
  }
  const recorded = new Set(
    db
      .prepare("SELECT name FROM schema_migrations")
      .all()
      .map((row) => row.name)
  );
  for (const [oldName, newName] of Object.entries(RENAMED)) {
    if (recorded.has(oldName) && !recorded.has(newName) && BASELINE_PROBES[newName](db)) {
      record.run(newName, "renamed:" + oldName);
      recorded.add(newName);
    }
  }
  const files = fs
    .readdirSync(sqlDir)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort(byNumber);

  for (const fileName of files) {
    if (recorded.has(fileName)) continue;
    applyMigration(db, sqlDir, fileName);
  }
}

/** Runs one .sql file in a transaction; a failure rolls everything back. */
function applyMigration(db, sqlDir, fileName) {
  const sql = fs.readFileSync(path.join(sqlDir, fileName), "utf8");
  db.exec("BEGIN");
  try {
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
      fileName,
      new Date().toISOString()
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw new Error(`migration ${fileName} failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Transactions
// ---------------------------------------------------------------------------

/** Write-contention counter per connection (ADR-0002 Postgres trigger). Read with dbBusy(db). */
const busyCounts = new WeakMap();
export const SLOW_TX_MS = 100;
export function dbBusy(db) {
  return busyCounts.get(db) || 0;
}
function isBusy(e) {
  return (
    !!e && (e.errcode === 5 || e.errcode === 6 || /SQLITE_BUSY|database is (locked|busy)/i.test(String(e.message)))
  );
}
function contention(db, what, ms) {
  busyCounts.set(db, dbBusy(db) + 1);
  console.warn(`[aq-api] db write contention: ${what} after ${Math.round(ms)} ms`); // never logs data values
}

/** Runs fn inside BEGIN IMMEDIATE..COMMIT (not re-entrant). Logs + counts SQLITE_BUSY and lock waits > SLOW_TX_MS. */
export function tx(db, fn) {
  const t0 = performance.now();
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (e) {
    if (isBusy(e)) contention(db, "SQLITE_BUSY on BEGIN", performance.now() - t0);
    throw e;
  }
  const waited = performance.now() - t0;
  if (waited > SLOW_TX_MS) contention(db, "slow lock wait", waited);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    if (isBusy(e)) contention(db, "SQLITE_BUSY in tx", performance.now() - t0);
    throw e;
  }
}

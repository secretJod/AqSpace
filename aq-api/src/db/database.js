/* database.js - opens the SQLite database and keeps its schema up to date.

   What:  openDb() opens (or creates) the file, sets pragmas and runs migrations.
          tx() runs a function inside a transaction.
   How it fits: app.js opens the database once; the repository files use tx().
   Migrations: every sql/NNN_*.sql file runs once, in name order, and is recorded
          in the `schema_migrations` table.
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

export function migrate(db, sqlDir) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const alreadyApplied = new Set(db.prepare("SELECT name FROM schema_migrations").all().map((row) => row.name));
  const files = fs.readdirSync(sqlDir).filter((f) => /^\d+.*\.sql$/.test(f)).sort();

  for (const fileName of files) {
    if (alreadyApplied.has(fileName)) continue;
    applyMigration(db, sqlDir, fileName);
  }
}

/** Runs one .sql file in a transaction; a failure rolls everything back. */
function applyMigration(db, sqlDir, fileName) {
  const sql = fs.readFileSync(path.join(sqlDir, fileName), "utf8");
  db.exec("BEGIN");
  try {
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(fileName, new Date().toISOString());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw new Error(`migration ${fileName} failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Transactions
// ---------------------------------------------------------------------------

/** Runs fn inside BEGIN IMMEDIATE..COMMIT (not re-entrant). */
export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

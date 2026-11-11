// #57 (web-dev-1): sql/*.sql run in filename order, exactly once, and safely on databases made by older code.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.js";

const SQL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sql");
const ALL = fs.readdirSync(SQL).filter((f) => f.endsWith(".sql")).sort();
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aq-mig-")), "aq.db");
const names = (db) => db.prepare("SELECT name FROM schema_migrations ORDER BY name").all().map((r) => r.name);
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
const run = (db, m) => db.exec(fs.readFileSync(path.join(SQL, m), "utf8"));

test("fresh db: every migration applied once, in order; reopening is a no-op", () => {
  const f = tmp();
  let db = openDb(f, SQL);
  assert.deepEqual(names(db), ALL);
  assert.ok(cols(db, "notes_jobs").includes("resumes"));
  assert.ok(tables(db).includes("smart_runs"));
  db.close();
  db = openDb(f, SQL);
  assert.deepEqual(names(db), ALL);
  db.close();
});

test("db with 001+002 recorded but not 003: only 003 runs", () => {
  const f = tmp();
  const raw = new DatabaseSync(f);
  raw.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const m of ALL.slice(0, 2)) { run(raw, m); raw.prepare("INSERT INTO schema_migrations VALUES (?, 'x')").run(m); }
  assert.ok(!tables(raw).includes("smart_runs"));
  raw.close();
  const db = openDb(f, SQL);
  assert.deepEqual(names(db), ALL);
  assert.ok(tables(db).includes("smart_runs"));
  db.close();
});

test("#14 db with 001-003 recorded: only 004 runs and adds the sessions table", () => {
  const f = tmp();
  const raw = new DatabaseSync(f);
  raw.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const m of ALL.slice(0, 3)) { run(raw, m); raw.prepare("INSERT INTO schema_migrations VALUES (?, 'x')").run(m); }
  raw.close();
  const db = openDb(f, SQL);
  assert.ok(ALL.includes("004_sessions.sql"));
  assert.deepEqual(names(db), ALL);
  assert.deepEqual(cols(db, "sessions"), ["id", "user_id", "created_at", "expires_at"]);
  db.close();
});

test("#151 db with 001-004 recorded: only 005 runs and adds users.picture; a baselined db with the column skips it", () => {
  const f = tmp();
  const raw = new DatabaseSync(f);
  raw.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const m of ALL.slice(0, 4)) { run(raw, m); raw.prepare("INSERT INTO schema_migrations VALUES (?, 'x')").run(m); }
  raw.close();
  const db = openDb(f, SQL);
  assert.ok(ALL.includes("005_user_picture.sql"));
  assert.deepEqual(names(db), ALL);
  assert.ok(cols(db, "users").includes("picture"));
  db.close();

  const f2 = tmp();
  const raw2 = new DatabaseSync(f2);
  for (const m of ALL.slice(0, 5)) run(raw2, m);           // no records table, picture column already there
  raw2.close();
  const db2 = openDb(f2, SQL);
  assert.equal(db2.prepare("SELECT applied_at FROM schema_migrations WHERE name = '005_user_picture.sql'").get().applied_at, "baseline");
  db2.close();
});

test("older db without a records table: existing schema is baselined, missing migrations run, data kept", () => {
  for (const upto of [1, 2, 3]) {
    const f = tmp();
    const raw = new DatabaseSync(f);
    for (const m of ALL.slice(0, upto)) run(raw, m);
    raw.exec("INSERT INTO users (id, name) VALUES (2, 'Keep me')");
    raw.close();
    const db = openDb(f, SQL);
    assert.deepEqual(names(db), ALL, `upto ${upto}`);
    assert.equal(db.prepare("SELECT name FROM users WHERE id = 2").get().name, "Keep me");
    assert.ok(cols(db, "notes_jobs").includes("resumes"));
    assert.ok(tables(db).includes("smart_runs"));
    db.close();
  }
});

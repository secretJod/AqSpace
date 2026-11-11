import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openDb, tx, dbBusy } from "../src/db.js";
import { startApp, startMockPython } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = path.join(HERE, "..", "sql");
const SCRIPT = path.join(HERE, "..", "..", "scripts", "backup-db.sh");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aq-db-"));

function quietWarn(fn) {
  const lines = []; const orig = console.warn;
  console.warn = (...a) => lines.push(a.join(" "));
  return Promise.resolve().then(fn).finally(() => { console.warn = orig; }).then(() => lines);
}

test("tx: SQLITE_BUSY is counted and logged without data values", async () => {
  const dir = tmp(); const file = path.join(dir, "aq.db");
  const a = openDb(file, SQL); const b = openDb(file, SQL);
  b.exec("PRAGMA busy_timeout = 0");
  a.exec("BEGIN IMMEDIATE");
  const lines = await quietWarn(() => {
    assert.throws(() => tx(b, () => b.prepare("INSERT INTO schema_migrations VALUES ('secret-value', 'x')").run()));
  });
  a.exec("ROLLBACK");
  assert.equal(dbBusy(b), 1);
  assert.equal(dbBusy(a), 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /db write contention: SQLITE_BUSY/);
  assert.doesNotMatch(lines[0], /secret-value/);
  a.close(); b.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("tx: a lock wait over 100 ms is counted; a fast tx is not", async () => {
  const dir = tmp(); const file = path.join(dir, "aq.db");
  const db = openDb(file, SQL);
  tx(db, () => db.prepare("SELECT 1").get());
  assert.equal(dbBusy(db), 0);
  const w = new Worker(`
    const { DatabaseSync } = require("node:sqlite"); const { parentPort, workerData } = require("node:worker_threads");
    const d = new DatabaseSync(workerData); d.exec("BEGIN IMMEDIATE"); parentPort.postMessage("locked");
    setTimeout(() => { d.exec("COMMIT"); d.close(); }, 250);`, { eval: true, workerData: file });
  await new Promise((r) => w.once("message", r));
  const lines = await quietWarn(() => tx(db, () => db.prepare("SELECT 1").get()));   // busy_timeout 5000 waits for the worker
  await new Promise((r) => w.once("exit", r));
  assert.equal(dbBusy(db), 1);
  assert.match(lines[0], /slow lock wait after \d+ ms/);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("health?deep=1 exposes dbBusy; plain health does not", async () => {
  const py = await startMockPython(); const app = await startApp({ py });
  try {
    assert.equal((await app.get("/api/v1/health?deep=1")).json.dbBusy, 0);
    assert.equal((await app.get("/api/v1/health")).json.dbBusy, undefined);
  } finally { await app.close(); await py.close(); }
});

test("backup-db.sh: VACUUM INTO copy is complete, open writers are fine, old backups pruned", () => {
  const dir = tmp(); const file = path.join(dir, "aq.db"); const out = path.join(dir, "backups");
  const db = openDb(file, SQL);                       // stays open (WAL) like a running stack
  db.exec("CREATE TABLE t (v TEXT)"); db.prepare("INSERT INTO t VALUES (?)").run("hello");
  fs.mkdirSync(out);
  for (const n of ["aq-20000101-000000.db", "aq-20000102-000000.db", "aq-20000103-000000.db"]) fs.writeFileSync(path.join(out, n), "old");
  const env = { ...process.env, DB_FILE: file, BACKUP_DIR: out };
  const log = execFileSync("bash", [SCRIPT, "2"], { env, encoding: "utf8" });
  assert.match(log, /Backup written: .*aq-\d{8}-\d{6}\.db/);
  const files = fs.readdirSync(out).sort();
  assert.equal(files.length, 2);
  assert.equal(files[0], "aq-20000103-000000.db");
  const copy = new DatabaseSync(path.join(out, files[1]), { readOnly: true });
  assert.equal(copy.prepare("SELECT v FROM t").get().v, "hello");
  copy.close(); db.close();
  assert.throws(() => execFileSync("bash", [SCRIPT], { env: { ...env, DB_FILE: path.join(dir, "nope.db") }, stdio: "pipe" }));
  fs.rmSync(dir, { recursive: true, force: true });
});

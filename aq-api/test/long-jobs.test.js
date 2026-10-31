/* #30 (R5): hours-long local-model jobs - no expiry by age, auto-resume after a Python restart, chunk progress, localModel health. */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, startMockPython, VID, JOB } from "./helpers.js";

let py, t, now;
const N = "/api/v1/notes";
beforeEach(async () => {
  now = 1_000_000;
  py = await startMockPython();
  t = await startApp({ py, clock: () => now });
  await t.post("/api/v1/playlists", { name: "L", videos: [{ id: VID(1), title: "one" }] });
});
afterEach(async () => { await t.close(); await py.close(); });

test("a running job is never expired or failed because of its age (hours later it is still running)", async () => {
  await t.post(`${N}/${VID(1)}`);
  for (const h of [1, 6, 23, 30]) {
    now = 1_000_000 + h * 3600_000;
    const r = await t.get(`${N}/${VID(1)}`);
    assert.equal(r.json.state, "running", `after ${h}h`);
    assert.equal(r.json.error, "");
  }
});

test("chunk progress (chunk i/N, stage) is passed through within the field limits", async () => {
  await t.post(`${N}/${VID(1)}`);
  Object.assign(py.state.jobs.get(JOB(1)), { stage: "map", message: "Summarising", chunk: 12, chunks: 480, pct: 7 });
  let r = await t.get(`${N}/${VID(1)}`);
  assert.equal(r.json.stage, "map");
  assert.equal(r.json.message, "Summarising (chunk 12/480)");

  Object.assign(py.state.jobs.get(JOB(1)), { message: "Chunk 13/480 done" });          // already in the message: not repeated
  assert.equal((await t.get(`${N}/${VID(1)}`)).json.message, "Chunk 13/480 done");

  Object.assign(py.state.jobs.get(JOB(1)), { stage: "s".repeat(50), message: "m".repeat(500), chunk: 14 });
  r = await t.get(`${N}/${VID(1)}`);
  assert.equal(r.json.stage.length, 20);
  assert.ok(r.json.message.length <= 160);
  assert.match(r.json.message, /\(chunk 14\/480\)$/);

  Object.assign(py.state.jobs.get(JOB(1)), { message: "x", chunk: 999, chunks: 3 });   // nonsense counters are ignored
  assert.equal((await t.get(`${N}/${VID(1)}`)).json.message, "x");
});

test("Python restart during a job: the same video is re-submitted once and the record keeps running", async () => {
  await t.post(`${N}/${VID(1)}`);
  py.state.jobs.clear();                                                 // restart: job id lost
  let r = await t.get(`${N}/${VID(1)}`);
  assert.equal(r.json.state, "queued");
  assert.equal(r.json.message, "Resuming after restart");
  assert.equal(r.json.stage, "resume");
  assert.equal(r.json.resumes, 1);
  assert.equal(r.json.jobId, JOB(2));
  assert.equal(py.state.jobsCreated.length, 2);
  assert.deepEqual(py.state.jobsCreated[1].body, py.state.jobsCreated[0].body);   // same video, same provider

  r = await t.get(`${N}/${VID(1)}`);                                     // new job found: running, no more re-submits
  assert.equal(r.json.state, "running");
  assert.equal(py.state.jobsCreated.length, 2);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM notes_jobs").get().n, 1);   // same record

  py.state.jobs.get(JOB(2)).status = "done";
  assert.equal((await t.get(`${N}/${VID(1)}`)).json.state, "ready");
});

test("concurrent polls after a restart re-submit only once", async () => {
  await t.post(`${N}/${VID(1)}`);
  py.state.jobs.clear();
  await Promise.all([1, 2, 3, 4, 5].map(() => t.get(`${N}/${VID(1)}`)));
  assert.equal(py.state.jobsCreated.length, 2);
});

test("auto-resume is capped: after maxAutoResumes restarts the record becomes a clear error; a manual start works", async () => {
  await t.post(`${N}/${VID(1)}`);
  for (let i = 1; i <= 3; i++) {
    py.state.jobs.clear();
    const r = await t.get(`${N}/${VID(1)}`);
    assert.equal(r.json.resumes, i);
    assert.equal(r.json.state, "queued");
  }
  py.state.jobs.clear();
  let r = await t.get(`${N}/${VID(1)}`);
  assert.equal(r.json.state, "error");
  assert.match(r.json.error, /restarted 4 times/);
  assert.equal(py.state.jobsCreated.length, 4);
  assert.equal((await t.get(`${N}/${VID(1)}`)).json.state, "error");    // stays put, no loop
  assert.equal(py.state.jobsCreated.length, 4);

  r = await t.post(`${N}/${VID(1)}`);
  assert.equal(r.status, 202);
  assert.equal(r.json.resumes, 0);
});

test("resume while Python is busy waits for a later poll; a refusal is an error", async () => {
  await t.post(`${N}/${VID(1)}`);
  py.state.jobs.clear();
  py.state.busy = true;
  let r = await t.get(`${N}/${VID(1)}`);
  assert.equal(r.json.state, "queued");
  assert.equal(r.json.message, "Waiting to resume after restart");
  assert.equal(r.json.resumes, 0);
  py.state.busy = false;

  py.state.rejectWith = "Video unavailable";
  r = await t.get(`${N}/${VID(1)}`);
  assert.equal(r.json.state, "error");
  assert.equal(r.json.error, "Video unavailable");
});

test("deep health reports localModel ok / offline from Python's provider list only", async () => {
  let r = await t.get("/api/v1/health");
  assert.equal(r.json.localModel, undefined);
  r = await t.get("/api/v1/health?deep=1");
  assert.equal(r.json.notesService, "ok");
  assert.equal(r.json.localModel, "offline");                            // no "local" provider listed yet

  py.state.providers = [{ id: "groq", server_key: true }, { id: "local", online: true }];
  assert.equal((await t.get("/api/v1/health?deep=1")).json.localModel, "ok");
  py.state.providers = [{ id: "local", online: false }];
  assert.equal((await t.get("/api/v1/health?deep=1")).json.localModel, "offline");

  py.state.providersStatus = 500;
  r = await t.get("/api/v1/health?deep=1");
  assert.equal(r.json.notesService, "error");
  assert.equal(r.json.localModel, "offline");

  await py.close();
  r = await t.get("/api/v1/health?deep=1");
  assert.equal(r.json.notesService, "offline");
  assert.equal(r.json.localModel, "offline");
  py = await startMockPython();
});

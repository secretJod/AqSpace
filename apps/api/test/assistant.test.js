/* assistant.test.js - POST /api/v1/ai/ask (services/assistant-service.js): answers from the signed-in user's own
   ready notes only, the playlist filter, citation links, the 409 / 422 / 502 mappings, input checks, and that
   neither the question nor the key is logged. Uses the mock worker from helpers.js and fake keys only. */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, startMockPython, VID, JOB } from "./helpers.js";

const ASK = "/api/v1/ai/ask";
const GROQ_KEY = "gsk_FAKEtestKEY0123456789abcdefWXYZ";
const BOB = { "x-user": "2" };

let py, t;
beforeEach(async () => {
  py = await startMockPython();
  t = await startApp({
    py,
    authenticate: (req, _res, next) => {
      req.user = { id: Number(req.headers["x-user"] || 1), name: "u" };
      next();
    }
  });
  t.db.prepare("INSERT INTO users (id, name) VALUES (2, 'bob')").run();
});
afterEach(async () => {
  await t.close();
  await py.close();
});

/** A ready notes job of `userId` for video n (job id = JOB(n * 10 + userId) so every row differs). */
function readyNotes(userId, n, status = "done") {
  t.db.prepare("INSERT OR IGNORE INTO videos (id, title) VALUES (?, ?)").run(VID(n), `Video ${n}`);
  t.db
    .prepare(
      "INSERT INTO notes_jobs (user_id, video_id, job_id, status, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'x', 'x')"
    )
    .run(userId, VID(n), JOB(n * 10 + userId), status, userId);
}

const playlist = (userId, name, ns) =>
  t.repo.createPlaylist(userId, { name, videos: ns.map((n) => ({ id: VID(n), title: `${name} lecture ${n}` })) })
    .playlist;

test("answers from the user's ready notes with camelCase citations and in-app links", async () => {
  const p = playlist(1, "Physics", [1]);
  readyNotes(1, 1);
  const r = await t.post(ASK, { question: "  What is\u0007 inertia?  " });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(r.json, {
    answer: "From your notes: 1",
    found: true,
    citations: [
      {
        videoId: VID(1),
        title: "Physics lecture 1",
        heading: "Intro",
        startSec: 75,
        url: `#/playlist/${p.id}/notes/${VID(1)}?t=75`
      }
    ],
    usedNotes: 1,
    provider: "groq"
  });
  const body = py.state.askBodies[0];
  assert.equal(body.question, "What is  inertia?"); // trimmed, control characters stripped
  assert.equal(body.provider, "groq");
  assert.equal("api_key" in body, false); // server key: nothing to send
  assert.deepEqual(body.jobs, [{ job_id: JOB(11), video_id: VID(1), title: "Physics lecture 1" }]);
});

test("only the user's own ready notes are sent (never another user's), newest first", async () => {
  readyNotes(1, 1);
  readyNotes(2, 2); // bob's
  readyNotes(2, 1); // bob's notes of the same video
  readyNotes(1, 3, "running");
  readyNotes(1, 4, "error");
  readyNotes(1, 5);
  await t.put("/api/v1/ai/keys/groq", { key: GROQ_KEY });

  let r = await t.post(ASK, { question: "q" });
  assert.equal(r.status, 200);
  let jobs = py.state.askBodies[0].jobs;
  assert.deepEqual(
    jobs.map((j) => j.job_id),
    [JOB(51), JOB(11)]
  );
  assert.equal(py.state.askBodies[0].api_key, GROQ_KEY); // the user's own key
  assert.equal(r.json.citations[0].url, null); // a video in no playlist has no link

  r = await t.post(ASK, { question: "q" }, BOB);
  assert.equal(r.status, 200);
  jobs = py.state.askBodies[1].jobs;
  assert.deepEqual(
    jobs.map((j) => j.job_id),
    [JOB(12), JOB(22)]
  );
  assert.equal("api_key" in py.state.askBodies[1], false); // alice's key is never used for bob
});

test("at most 50 notes are sent", async () => {
  for (let n = 1; n <= 55; n++) readyNotes(1, n);
  await t.post(ASK, { question: "q" });
  assert.equal(py.state.askBodies[0].jobs.length, 50);
  assert.equal(py.state.askBodies[0].jobs[0].video_id, VID(55));
});

test("playlist filter: only that playlist's videos, which must be the user's own playlist", async () => {
  const a = playlist(1, "A", [1, 2]);
  playlist(1, "B", [3]);
  const bobs = playlist(2, "Bob", [3]);
  for (const n of [1, 2, 3]) readyNotes(1, n);

  let r = await t.post(ASK, { question: "q", playlistId: a.id });
  assert.equal(r.status, 200);
  assert.deepEqual(
    py.state.askBodies[0].jobs.map((j) => j.video_id),
    [VID(2), VID(1)]
  );
  assert.equal(r.json.citations[0].url, `#/playlist/${a.id}/notes/${VID(2)}?t=75`);

  r = await t.post(ASK, { question: "q", playlistId: bobs.id });
  assert.equal(r.status, 404);
  r = await t.post(ASK, { question: "q", playlistId: "Bad Slug!" });
  assert.equal(r.status, 400);
  assert.equal(py.state.askBodies.length, 1);
});

test("no ready notes: 200 found false without calling the worker or needing a key", async () => {
  py.state.serverKeys = {};
  readyNotes(2, 1); // bob's only
  const r = await t.post(ASK, { question: "anything?" });
  assert.equal(r.status, 200);
  assert.equal(r.json.found, false);
  assert.deepEqual(r.json.citations, []);
  assert.equal(r.json.usedNotes, 0);
  assert.equal(py.state.askBodies.length, 0);
});

test("409 ai_key_required passes through when neither the user nor the server has a key", async () => {
  py.state.serverKeys = {};
  readyNotes(1, 1);
  const r = await t.post(ASK, { question: "q" });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "ai_key_required");
  assert.equal(r.json.task, "assistant");
  assert.equal(py.state.askBodies.length, 0);
});

test("worker key/quota problems become 422 {error, kind}; busy is 429; offline and garbage are 502", async () => {
  readyNotes(1, 1);
  py.state.askAnswer = () => [400, { error: "Quota exceeded for this key.", kind: "quota" }];
  let r = await t.post(ASK, { question: "q" });
  assert.equal(r.status, 422);
  assert.deepEqual(r.json, { error: "Quota exceeded for this key.", kind: "quota" });

  py.state.askAnswer = () => [401, { error: "Bad key", kind: "weird" }];
  r = await t.post(ASK, { question: "q" });
  assert.deepEqual([r.status, r.json.kind], [422, "other"]);

  py.state.askAnswer = () => [429, { error: "busy" }];
  r = await t.post(ASK, { question: "q" });
  assert.equal(r.status, 429);

  py.state.askAnswer = () => [500, { oops: true }];
  r = await t.post(ASK, { question: "q" });
  assert.deepEqual([r.status, r.json.code], [502, "py_offline"]);

  // citations the worker invents for videos that were not sent are dropped
  py.state.askAnswer = () => [
    200,
    { answer: "a", found: true, citations: [{ video_id: VID(9), heading: "x", start_sec: 1 }], used_notes: 1 }
  ];
  r = await t.post(ASK, { question: "q" });
  assert.deepEqual(r.json.citations, []);

  await py.close();
  r = await t.post(ASK, { question: "q" });
  assert.deepEqual([r.status, r.json.code], [502, "py_offline"]);
});

test("input validation: 400 for a missing, empty, too long or non-string question", async () => {
  readyNotes(1, 1);
  for (const body of [{}, { question: "" }, { question: "   " }, { question: 5 }, { question: "x".repeat(501) }, []]) {
    const r = await t.post(ASK, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await t.post(ASK, { question: "x".repeat(500) })).status, 200);
  assert.equal(py.state.askBodies.length, 1);
});

test("the question and the key are never logged", async () => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(" "));
  const logged = await startApp({ py, overrides: { log: true } });
  try {
    logged.db.prepare("INSERT OR IGNORE INTO videos (id) VALUES (?)").run(VID(1));
    logged.db
      .prepare(
        "INSERT INTO notes_jobs (user_id, video_id, job_id, status, created_at, updated_at) VALUES (1, ?, ?, 'done', 'x', 'x')"
      )
      .run(VID(1), JOB(1));
    await logged.put("/api/v1/ai/keys/groq", { key: GROQ_KEY });
    await logged.post(ASK, { question: "SECRET-QUESTION-xyz" });
    py.state.askAnswer = () => [400, { error: "bad", kind: "invalid" }];
    await logged.post(ASK, { question: "SECRET-QUESTION-xyz" });
  } finally {
    Object.assign(console, orig);
    await logged.close();
  }
  assert.ok(lines.some((l) => l.includes("/api/v1/ai/ask"))); // the request logger did run
  assert.ok(!lines.some((l) => l.includes("SECRET-QUESTION") || l.includes(GROQ_KEY)));
});

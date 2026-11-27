/* private-notes.test.js - notes belong to the user who made them (AUTH_MODE=google, mocked Google and worker):
   two users make notes for the same video independently, nobody sees another user's notes, the first Google
   account keeps the local user's notes, migration 006 backfills owners, and local mode is unchanged.
   Helpers: test/helpers.js. Read next: src/services/notes-service.js */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/database.js";
import { startApp, startMockPython, VID, JOB } from "./helpers.js";

const G = {
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: "shh",
  redirectUri: "http://localhost:5180/api/v1/auth/google/callback",
  sessionSecret: "x".repeat(40),
  sessionMaxAgeMs: 3_600_000,
  afterLogin: "/",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://google.test/token",
  tokeninfoUrl: "https://google.test/tokeninfo"
};
const N = "/api/v1/notes";
const SQL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sql");

/** A fake Google whose signed-in account (`sub`, name, email) the test can switch between logins. */
function mockGoogle() {
  const st = {
    info: {
      aud: G.clientId,
      iss: "https://accounts.google.com",
      sub: "g-ann",
      email: "ann@x.test",
      email_verified: true,
      name: "Ann",
      exp: String(Math.floor(Date.now() / 1000) + 3600)
    }
  };
  st.fetch = async (url) => {
    const json = (code, o) =>
      new Response(JSON.stringify(o), { status: code, headers: { "content-type": "application/json" } });
    if (String(url) === G.tokenUrl) return json(200, { id_token: "idtok" });
    if (String(url).startsWith(G.tokeninfoUrl)) return json(200, st.info);
    return json(404, {});
  };
  return st;
}

let t, py, google;
afterEach(async () => {
  if (t) await t.close();
  if (py) await py.close();
  t = py = null;
});

async function startGoogle() {
  py = await startMockPython();
  google = mockGoogle();
  t = await startApp({ py, overrides: { authMode: "google", google: G }, googleFetch: google.fetch });
}

const raw = (p, headers = {}) => fetch(t.base + p, { headers, redirect: "manual" });
const cookieOf = (res, name) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(name + "="))
    ?.split(";")[0];

/** Signs in as the given Google account and returns {id, cookie} for its session. */
async function signIn(sub, name) {
  Object.assign(google.info, { sub, name, email: `${name.toLowerCase()}@x.test` });
  const r1 = await raw("/api/v1/auth/google/login");
  const state = new URL(r1.headers.get("location")).searchParams.get("state");
  const r2 = await raw(`/api/v1/auth/google/callback?code=abc&state=${state}`, {
    cookie: cookieOf(r1, "aq_oauth_state")
  });
  const cookie = cookieOf(r2, "aq_session");
  const me = await t.get("/api/v1/me", { cookie });
  return { id: me.json.user.id, cookie };
}

/** A user with a playlist holding the given videos (notes can only be started for videos in your playlists). */
async function userWithVideos(sub, name, ids) {
  const u = await signIn(sub, name);
  const r = await t.post(
    "/api/v1/playlists",
    { name: "L", videos: ids.map((id) => ({ id, title: id })) },
    {
      cookie: u.cookie
    }
  );
  assert.equal(r.status, 201);
  return u;
}

test("two users make notes for the same video independently, each with their own worker job", async () => {
  await startGoogle();
  const ann = await userWithVideos("g-ann", "Ann", [VID(1)]);
  const bob = await userWithVideos("g-bob", "Bob", [VID(1)]);

  let r = await t.post(`${N}/${VID(1)}`, undefined, { cookie: ann.cookie });
  assert.equal(r.status, 202);
  assert.equal(r.json.jobId, JOB(1));

  // Bob does not see Ann's running job and starting his own makes a new worker job.
  r = await t.get(`${N}/${VID(1)}`, { cookie: bob.cookie });
  assert.equal(r.json.state, "none");
  assert.equal(r.json.jobId, null);
  r = await t.post(`${N}/${VID(1)}`, undefined, { cookie: bob.cookie });
  assert.equal(r.status, 202);
  assert.equal(r.json.jobId, JOB(2));
  assert.equal(py.state.jobsCreated.length, 2);

  // Each user's repeated start returns their own job.
  r = await t.post(`${N}/${VID(1)}`, undefined, { cookie: ann.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.jobId, JOB(1));
  r = await t.post(`${N}/${VID(1)}`, undefined, { cookie: bob.cookie });
  assert.equal(r.json.jobId, JOB(2));

  const rows = t.db.prepare("SELECT user_id, job_id FROM notes_jobs ORDER BY id").all();
  assert.deepEqual(
    rows.map((x) => [x.user_id, x.job_id]),
    [
      [ann.id, JOB(1)],
      [bob.id, JOB(2)]
    ]
  );
});

test("another user's notes look like they do not exist: status none, html and pdf 404, not in the list", async () => {
  await startGoogle();
  const ann = await userWithVideos("g-ann", "Ann", [VID(1), VID(2)]);
  const bob = await userWithVideos("g-bob", "Bob", [VID(1), VID(3)]);

  await t.post(`${N}/${VID(1)}`, undefined, { cookie: ann.cookie });
  await t.post(`${N}/${VID(2)}`, undefined, { cookie: ann.cookie });
  py.state.jobs.get(JOB(1)).status = "done";
  assert.equal((await t.get(`${N}/${VID(1)}`, { cookie: ann.cookie })).json.state, "ready");
  assert.equal((await t.get(`${N}/${VID(1)}/html`, { cookie: ann.cookie })).status, 200);
  assert.equal((await t.get(`${N}/${VID(1)}/pdf`, { cookie: ann.cookie })).status, 200);

  // Bob: nothing of Ann's is reachable, by status, file or list.
  const st = await t.get(`${N}/${VID(1)}`, { cookie: bob.cookie });
  assert.equal(st.json.state, "none");
  assert.equal(st.json.jobId, null);
  assert.equal((await t.get(`${N}/${VID(2)}`, { cookie: bob.cookie })).json.state, "none");
  for (const kind of ["html", "pdf"]) {
    const r = await t.get(`${N}/${VID(1)}/${kind}`, { cookie: bob.cookie });
    assert.equal(r.status, 404, kind);
    assert.ok(!r.text.includes("notes</h1>") && !r.text.includes("%PDF"), kind);
  }
  assert.deepEqual((await t.get(N, { cookie: bob.cookie })).json, { notes: [] });

  // Bob's own job shows only in his list; Ann's list has only hers.
  await t.post(`${N}/${VID(3)}`, undefined, { cookie: bob.cookie });
  assert.deepEqual(
    (await t.get(N, { cookie: bob.cookie })).json.notes.map((n) => n.videoId),
    [VID(3)]
  );
  assert.deepEqual(
    (await t.get(N, { cookie: ann.cookie })).json.notes.map((n) => n.videoId),
    [VID(1), VID(2)]
  );

  // Signed out, notes are not reachable at all.
  assert.equal((await t.get(N)).status, 401);
  assert.equal((await t.get(`${N}/${VID(1)}/pdf`)).status, 401);
});

test("an error on one user's job does not show for, or block, another user", async () => {
  await startGoogle();
  const ann = await userWithVideos("g-ann", "Ann", [VID(1)]);
  const bob = await userWithVideos("g-bob", "Bob", [VID(1)]);
  await t.post(`${N}/${VID(1)}`, undefined, { cookie: ann.cookie });
  Object.assign(py.state.jobs.get(JOB(1)), { status: "error", error: "boom" });
  assert.equal((await t.get(`${N}/${VID(1)}`, { cookie: ann.cookie })).json.state, "error");
  assert.equal((await t.get(`${N}/${VID(1)}`, { cookie: bob.cookie })).json.state, "none");
  assert.equal((await t.post(`${N}/${VID(1)}`, undefined, { cookie: bob.cookie })).status, 202);
});

test("auto-resume after a worker restart works per user and video", async () => {
  await startGoogle();
  const ann = await userWithVideos("g-ann", "Ann", [VID(1)]);
  const bob = await userWithVideos("g-bob", "Bob", [VID(1)]);
  await t.post(`${N}/${VID(1)}`, undefined, { cookie: ann.cookie });
  await t.post(`${N}/${VID(1)}`, undefined, { cookie: bob.cookie });
  py.state.jobs.delete(JOB(1)); // the worker lost Ann's job only

  const r = await t.get(`${N}/${VID(1)}`, { cookie: ann.cookie });
  assert.equal(r.json.jobId, JOB(3));
  assert.equal(r.json.resumes, 1);
  assert.equal((await t.get(`${N}/${VID(1)}`, { cookie: bob.cookie })).json.jobId, JOB(2));
  assert.equal(t.db.prepare("SELECT resumes FROM notes_jobs WHERE user_id = ?").get(bob.id).resumes, 0);
});

test("the first Google account keeps the local user's notes; the second starts with none", async () => {
  await startGoogle();
  t.db.prepare("INSERT INTO videos (id) VALUES (?)").run(VID(1));
  t.db
    .prepare(
      "INSERT INTO notes_jobs (user_id, video_id, job_id, status, requested_by, created_at, updated_at) VALUES (1, ?, ?, 'done', 1, 'x', 'x')"
    )
    .run(VID(1), JOB(9));
  py.state.jobs.set(JOB(9), { status: "done", pct: 100 });

  const ann = await signIn("g-ann", "Ann");
  const bob = await signIn("g-bob", "Bob");
  assert.equal(t.db.prepare("SELECT count(*) n FROM notes_jobs WHERE user_id = 1").get().n, 0);
  assert.deepEqual(
    (await t.get(N, { cookie: ann.cookie })).json.notes.map((n) => [n.videoId, n.state]),
    [[VID(1), "ready"]]
  );
  assert.equal((await t.get(`${N}/${VID(1)}/pdf`, { cookie: ann.cookie })).status, 200);
  assert.deepEqual((await t.get(N, { cookie: bob.cookie })).json, { notes: [] });
  assert.equal((await t.get(`${N}/${VID(1)}/pdf`, { cookie: bob.cookie })).status, 404);
});

test("smart arrange and progress are per user", async () => {
  await startGoogle();
  const ann = await userWithVideos("g-ann", "Ann", [VID(1)]);
  const bob = await signIn("g-bob", "Bob");
  const slug = (await t.get("/api/v1/playlists", { cookie: ann.cookie })).json.playlists[0].id;
  assert.equal((await t.get(`/api/v1/playlists/${slug}/smart`, { cookie: bob.cookie })).status, 404);
  assert.equal((await t.post(`/api/v1/playlists/${slug}/smart`, undefined, { cookie: bob.cookie })).status, 404);

  const put = await t.put(`/api/v1/progress/${VID(1)}`, { pos: 30, dur: 60 }, { cookie: ann.cookie });
  assert.equal(put.status, 200);
  assert.deepEqual(Object.keys((await t.get("/api/v1/progress", { cookie: ann.cookie })).json.progress), [VID(1)]);
  assert.deepEqual((await t.get("/api/v1/progress", { cookie: bob.cookie })).json.progress, {});
  assert.equal((await t.get(`/api/v1/progress/${VID(1)}`, { cookie: bob.cookie })).status, 404);
});

test("local mode is unchanged: the single local user owns, lists and downloads notes", async () => {
  py = await startMockPython();
  t = await startApp({ py });
  await t.post("/api/v1/playlists", { name: "L", videos: [{ id: VID(1), title: "one" }] });
  assert.equal((await t.post(`${N}/${VID(1)}`)).status, 202);
  py.state.jobs.get(JOB(1)).status = "done";
  assert.equal((await t.get(`${N}/${VID(1)}`)).json.state, "ready");
  assert.equal((await t.get(`${N}/${VID(1)}/pdf`)).status, 200);
  assert.deepEqual(
    (await t.get(N)).json.notes.map((n) => n.videoId),
    [VID(1)]
  );
  assert.equal(t.db.prepare("SELECT user_id FROM notes_jobs").get().user_id, 1);
});

test("migration 006 gives existing notes jobs an owner from requested_by (unknown requester: the local user)", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aq-mig-")), "aq.db");
  const old = new DatabaseSync(f);
  old.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const m of fs
    .readdirSync(SQL)
    .filter((x) => /^00[1-5]_.*\.sql$/.test(x))
    .sort()) {
    old.exec(fs.readFileSync(path.join(SQL, m), "utf8"));
    old.prepare("INSERT INTO schema_migrations VALUES (?, 'x')").run(m);
  }
  old.exec("INSERT INTO users (id, name, external_id) VALUES (2, 'Ann', 'g-ann')");
  old.prepare("INSERT INTO videos (id) VALUES (?), (?), (?)").run(VID(1), VID(2), VID(3));
  const ins = old.prepare(
    "INSERT INTO notes_jobs (video_id, job_id, status, requested_by, created_at, updated_at, resumes) VALUES (?, ?, ?, ?, 'c', 'u', ?)"
  );
  ins.run(VID(1), JOB(1), "done", 2, 1);
  ins.run(VID(2), JOB(2), "running", 1, 0);
  ins.run(VID(3), JOB(3), "error", null, 0);
  old.close();

  const db = openDb(f, SQL);
  const rows = db.prepare("SELECT id, user_id, video_id, job_id, status, requested_by, resumes FROM notes_jobs").all();
  assert.deepEqual(
    rows.map((r) => [r.user_id, r.video_id, r.job_id, r.status, r.requested_by, r.resumes]),
    [
      [2, VID(1), JOB(1), "done", 2, 1],
      [1, VID(2), JOB(2), "running", 1, 0],
      [1, VID(3), JOB(3), "error", null, 0]
    ]
  );
  // the live-job rule is now per (user, video)
  db.prepare(
    "INSERT INTO notes_jobs (user_id, video_id, status, created_at, updated_at) VALUES (1, ?, 'queued', 'x', 'x')"
  ).run(VID(1));
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO notes_jobs (user_id, video_id, status, created_at, updated_at) VALUES (2, ?, 'queued', 'x', 'x')"
        )
        .run(VID(1)),
    /UNIQUE/
  );
  db.close();
});

test("live preview: a running job's pages are only visible to its owner", async () => {
  await startGoogle();
  const ann = await userWithVideos("g-ann", "Ann", [VID(1)]);
  const bob = await userWithVideos("g-bob", "Bob", [VID(1)]);
  await t.post(`${N}/${VID(1)}`, undefined, { cookie: ann.cookie });

  // No pages yet: 404 even for the owner.
  assert.equal((await t.get(`${N}/${VID(1)}/draft`, { cookie: ann.cookie })).status, 404);

  py.state.jobs.get(JOB(1)).pages = 2;
  const st = await t.get(`${N}/${VID(1)}`, { cookie: ann.cookie });
  assert.equal(st.json.state, "running");
  assert.equal(st.json.pages, 2);
  const own = await t.get(`${N}/${VID(1)}/draft`, { cookie: ann.cookie });
  assert.equal(own.status, 200);
  assert.match(own.text, /draft 2/);

  // Bob sees neither the page count nor the draft.
  assert.equal((await t.get(`${N}/${VID(1)}`, { cookie: bob.cookie })).json.pages, 0);
  const other = await t.get(`${N}/${VID(1)}/draft`, { cookie: bob.cookie });
  assert.equal(other.status, 404);
  assert.ok(!other.text.includes("draft 2"));
  assert.equal((await t.get(`${N}/${VID(1)}/draft`)).status, 401);
});

test("own AI keys are per user: listed, used and deletable only by their owner", async () => {
  await startGoogle();
  const KEY = "gsk_FAKEannKEY0123456789abcdefANNK";
  const ann = await userWithVideos("g-ann", "Ann", [VID(1)]);
  const bob = await userWithVideos("g-bob", "Bob", [VID(1)]);
  py.state.serverKeys = {}; // the worker has no key of its own
  assert.equal((await t.put("/api/v1/ai/keys/groq", { key: KEY }, { cookie: ann.cookie })).status, 200);

  const groq = (r) => r.json.providers.find((p) => p.id === "groq");
  assert.equal(groq(await t.get("/api/v1/ai", { cookie: ann.cookie })).connected, true);
  assert.equal(groq(await t.get("/api/v1/ai", { cookie: bob.cookie })).connected, false);

  // Ann's job carries her key, Bob is asked to connect his own
  // (Ann's key is never borrowed) and no worker job is started for him.
  await t.post(`${N}/${VID(1)}`, undefined, { cookie: ann.cookie });
  assert.equal(py.state.jobsCreated[0].body.api_key, KEY);
  const r = await t.post(`${N}/${VID(1)}`, undefined, { cookie: bob.cookie });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "ai_key_required");
  assert.equal(py.state.jobsCreated.length, 1);

  // Bob deleting "his" groq key does not touch Ann's.
  assert.equal((await t.del("/api/v1/ai/keys/groq", { cookie: bob.cookie })).status, 204);
  assert.equal(groq(await t.get("/api/v1/ai", { cookie: ann.cookie })).connected, true);
  assert.equal((await t.get("/api/v1/ai")).status, 401);
});

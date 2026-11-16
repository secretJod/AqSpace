// #151 (web-dev-1): Google profile (picture), /auth/status, /me shape, ?next= round trip, auth_required, claiming local data, CSP.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, VID } from "./helpers.js";
import { safeNext } from "../src/middleware/google-auth.js";

const G = {
  clientId: "cid.apps.googleusercontent.com", clientSecret: "shh", redirectUri: "http://localhost:5180/api/v1/auth/google/callback",
  sessionSecret: "x".repeat(40), sessionMaxAgeMs: 3_600_000, afterLogin: "/",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://google.test/token", tokeninfoUrl: "https://google.test/tokeninfo"
};
const PIC = "https://lh3.googleusercontent.com/a/photo=s96-c";

function mockGoogle() {
  const st = { info: { aud: G.clientId, iss: "https://accounts.google.com", sub: "g-1", email: "ann@x.test", email_verified: true, name: "Ann", picture: PIC, exp: String(Math.floor(Date.now() / 1000) + 3600) } };
  st.fetch = async (url) => {
    const json = (code, o) => new Response(JSON.stringify(o), { status: code, headers: { "content-type": "application/json" } });
    if (String(url) === G.tokenUrl) return json(200, { id_token: "idtok" });
    if (String(url).startsWith(G.tokeninfoUrl)) return json(200, st.info);
    return json(404, {});
  };
  return st;
}

let t, google;
afterEach(async () => { if (t) await t.close(); t = null; });
const startGoogle = async () => { google = mockGoogle(); t = await startApp({ overrides: { authMode: "google", google: G }, googleFetch: google.fetch, withUi: true }); };
const raw = (p, headers = {}, method = "GET") => fetch(t.base + p, { method, headers, redirect: "manual" });
const cookieOf = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(name + "="))?.split(";")[0];
async function login(next) {
  const r1 = await raw("/api/v1/auth/google/login" + (next !== undefined ? "?next=" + encodeURIComponent(next) : ""));
  const state = new URL(r1.headers.get("location")).searchParams.get("state");
  const r2 = await raw(`/api/v1/auth/google/callback?code=abc&state=${state}`, { cookie: cookieOf(r1, "aq_oauth_state") });
  return { r2, session: cookieOf(r2, "aq_session") };
}

test("local mode: /auth/status is signed in as the local user; /me has the full profile shape", async () => {
  t = await startApp();
  const s = await t.get("/api/v1/auth/status");
  assert.equal(s.status, 200);
  assert.deepEqual(s.json, { authMode: "local", signedIn: true, user: { id: 1, name: "local", email: null, picture: null }, loginUrl: "/api/v1/auth/google/login" });
  const me = await t.get("/api/v1/me");
  assert.deepEqual(me.json, { user: { id: 1, name: "local", email: null, picture: null }, bootstrapped: false });
});

test("google mode: status works signed out; other routes give 401 auth_required; after sign-in status + /me carry the photo", async () => {
  await startGoogle();
  const s = await t.get("/api/v1/auth/status");
  assert.deepEqual(s.json, { authMode: "google", signedIn: false, user: null, loginUrl: "/api/v1/auth/google/login" });
  for (const p of ["/api/v1/me", "/api/v1/playlists", "/api/v1/progress"]) {
    const r = await t.get(p);
    assert.equal(r.status, 401, p);
    assert.deepEqual(r.json, { error: "Sign in required.", code: "auth_required" });
  }
  assert.equal((await t.post("/api/v1/playlists", { name: "x" })).json.code, "auth_required");

  const { session } = await login();
  const st = await t.get("/api/v1/auth/status", { cookie: session });
  assert.equal(st.json.signedIn, true);
  assert.deepEqual(st.json.user, { id: st.json.user.id, name: "Ann", email: "ann@x.test", picture: PIC });
  const me = await t.get("/api/v1/me", { cookie: session });
  assert.equal(me.json.user.picture, PIC);

  google.info.picture = PIC + "2"; google.info.name = "Ann B";          // refreshed on every sign-in
  const again = await login();
  const u = (await t.get("/api/v1/me", { cookie: again.session })).json.user;
  assert.equal(u.picture, PIC + "2"); assert.equal(u.name, "Ann B");
  google.info.picture = "javascript:alert(1)";                          // non-https photo is dropped
  const third = await login();
  assert.equal((await t.get("/api/v1/me", { cookie: third.session })).json.user.picture, null);
});

test("logout: {ok:true}, deletes the session, status goes back to signed out", async () => {
  await startGoogle();
  const { session } = await login();
  const out = await raw("/api/v1/auth/logout", { cookie: session }, "POST");
  assert.deepEqual(await out.json(), { ok: true });
  assert.equal(t.db.prepare("SELECT count(*) n FROM sessions").get().n, 0);
  assert.equal((await t.get("/api/v1/auth/status", { cookie: session })).json.signedIn, false);
  assert.equal((await t.get("/api/v1/me", { cookie: session })).json.code, "auth_required");
});

test("?next= survives the round trip; unsafe values fall back to /", async () => {
  await startGoogle();
  assert.equal((await login("/#/playlist/abc?x=1")).r2.headers.get("location"), "/#/playlist/abc?x=1");
  for (const bad of ["//evil.test", "https://evil.test", "/\\evil.test", "evil", "/a b", "/x\r\nSet-Cookie: a=b"]) {
    assert.equal((await login(bad)).r2.headers.get("location"), "/", bad);
  }
  assert.equal((await login()).r2.headers.get("location"), "/");
  assert.equal(safeNext("/profile"), "/profile");
  assert.equal(safeNext("/" + "a".repeat(600)), null);
  assert.equal(safeNext(["/a"]), null);
});

test("claim: the first Google user takes over all local-user data once, in one go; later users start empty", async () => {
  await startGoogle();
  const db = t.db;
  // local user's data: a playlist with a video, progress, a notes job and a smart run, plus the bootstrapped flag
  assert.equal((await t.post("/api/v1/playlists", { name: "Old", videos: [{ id: VID(1), title: "v" }] }, { cookie: "" })).status, 401);
  db.prepare("INSERT INTO videos (id) VALUES (?)").run(VID(1));
  const pk = Number(db.prepare("INSERT INTO playlists (user_id, slug, name, created_at, updated_at) VALUES (1, 'old', 'Old', 'x', 'x')").run().lastInsertRowid);
  db.prepare("INSERT INTO playlist_videos (playlist_pk, video_id, position, added_at) VALUES (?, ?, 0, 'x')").run(pk, VID(1));
  db.prepare("INSERT INTO watch_progress (user_id, video_id, pos_sec, dur_sec, updated_ms) VALUES (1, ?, 10, 60, 1)").run(VID(1));
  db.prepare("INSERT INTO notes_jobs (video_id, status, requested_by, created_at, updated_at) VALUES (?, 'done', 1, 'x', 'x')").run(VID(1));
  db.prepare("INSERT INTO smart_runs (playlist_pk, fingerprint, status, requested_by, created_at, updated_at) VALUES (?, 'f', 'done', 1, 'x', 'x')").run(pk);
  db.prepare("UPDATE users SET bootstrapped_at = 'yes' WHERE id = 1").run();

  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(" "));
  let first;
  try { first = await login(); } finally { console.log = orig; }
  const me = (await t.get("/api/v1/me", { cookie: first.session })).json;
  const uid = me.user.id;
  assert.notEqual(uid, 1);
  assert.equal(me.bootstrapped, true);
  assert.equal(logs.filter((l) => l.includes("claimed")).length, 1);
  const pls = (await t.get("/api/v1/playlists", { cookie: first.session })).json;
  assert.equal(JSON.stringify(pls).includes("Old"), true);
  for (const [tb, c] of [["playlists", "user_id"], ["watch_progress", "user_id"], ["notes_jobs", "requested_by"], ["smart_runs", "requested_by"]]) {
    assert.equal(db.prepare(`SELECT count(*) n FROM ${tb} WHERE ${c} = 1`).get().n, 0, tb);
    assert.equal(db.prepare(`SELECT count(*) n FROM ${tb} WHERE ${c} = ?`).get(uid).n, 1, tb);
  }

  // signing in again does not claim again; a second Google account starts empty
  logs.length = 0; console.log = (...a) => logs.push(a.join(" "));
  let second;
  try { await login(); google.info.sub = "g-2"; google.info.email = "bob@x.test"; second = await login(); } finally { console.log = orig; }
  assert.equal(logs.filter((l) => l.includes("claimed")).length, 0);
  const bob = (await t.get("/api/v1/me", { cookie: second.session })).json;
  assert.notEqual(bob.user.id, uid);
  assert.equal(bob.bootstrapped, false);
  assert.equal(JSON.stringify((await t.get("/api/v1/playlists", { cookie: second.session })).json).includes("Old"), false);
});

test("CSP lets the UI show Google profile photos; the API CSP is unchanged", async () => {
  t = await startApp({ withUi: true });
  assert.match((await t.get("/")).headers.get("content-security-policy"), /img-src [^;]*https:\/\/lh3\.googleusercontent\.com/);
  assert.equal((await t.get("/api/v1/auth/status")).headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'self'");
});

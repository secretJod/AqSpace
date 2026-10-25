import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./helpers.js";

const G = {
  clientId: "cid.apps.googleusercontent.com", clientSecret: "shh", redirectUri: "http://localhost:5180/api/v1/auth/google/callback",
  sessionSecret: "x".repeat(40), sessionMaxAgeMs: 3_600_000, afterLogin: "/",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://google.test/token", tokeninfoUrl: "https://google.test/tokeninfo"
};

// mocked Google: token endpoint + tokeninfo endpoint
let google;
function mockGoogle() {
  const st = { calls: [], info: { aud: G.clientId, iss: "https://accounts.google.com", sub: "g-123", email: "a@b.c", email_verified: "true", name: "Ann", exp: String(Math.floor(Date.now() / 1000) + 3600) }, tokenOk: true };
  st.fetch = async (url, init) => {
    st.calls.push({ url: String(url), init });
    const json = (code, o) => new Response(JSON.stringify(o), { status: code, headers: { "content-type": "application/json" } });
    if (String(url) === G.tokenUrl) return st.tokenOk ? json(200, { id_token: "idtok", access_token: "a" }) : json(400, { error: "invalid_grant" });
    if (String(url).startsWith(G.tokeninfoUrl)) return json(200, st.info);
    return json(404, {});
  };
  return st;
}

let t;
beforeEach(async () => { google = mockGoogle(); t = await startApp({ overrides: { authMode: "google", google: G }, googleFetch: google.fetch, withUi: true }); });
afterEach(async () => { await t.close(); });

const raw = (p, headers = {}, method = "GET") => fetch(t.base + p, { method, headers, redirect: "manual" });
const cookieOf = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(name + "="))?.split(";")[0];

async function login() {
  const r1 = await raw("/api/v1/auth/google/login");
  const state = new URL(r1.headers.get("location")).searchParams.get("state");
  const sc = cookieOf(r1, "aq_oauth_state");
  const r2 = await raw(`/api/v1/auth/google/callback?code=abc&state=${state}`, { cookie: sc });
  return { r1, r2, session: cookieOf(r2, "aq_session") };
}

test("google mode: API needs a session, health and the UI do not", async () => {
  assert.equal((await t.get("/api/v1/me")).status, 401);
  assert.equal((await t.get("/api/v1/playlists")).status, 401);
  assert.equal((await t.get("/api/v1/health")).status, 200);
  assert.equal((await t.get("/")).status, 200);
});

test("login redirects to Google with state + configured redirect URI", async () => {
  const r = await raw("/api/v1/auth/google/login");
  assert.equal(r.status, 302);
  const u = new URL(r.headers.get("location"));
  assert.equal(u.origin + u.pathname, G.authUrl);
  assert.equal(u.searchParams.get("client_id"), G.clientId);
  assert.equal(u.searchParams.get("redirect_uri"), G.redirectUri);
  assert.match(u.searchParams.get("state"), /^[a-f0-9]{32}$/);
  assert.match(r.headers.getSetCookie().join(), /aq_oauth_state=.*HttpOnly.*SameSite=Lax/i);
});

test("callback creates the user (external_id = sub), sets a session, /me returns the user, logout clears it", async () => {
  const { r2, session } = await login();
  assert.equal(r2.status, 302);
  assert.equal(r2.headers.get("location"), "/");
  assert.ok(session);
  assert.match(r2.headers.getSetCookie().join(), /aq_session=.*HttpOnly/i);
  const tokenCall = google.calls.find((c) => c.url === G.tokenUrl);
  assert.equal(new URLSearchParams(tokenCall.init.body.toString()).get("redirect_uri"), G.redirectUri);

  const me = await t.get("/api/v1/me", { cookie: session });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.name, "Ann");
  assert.notEqual(me.json.user.id, 1);
  assert.equal(t.db.prepare("SELECT external_id FROM users WHERE id = ?").get(me.json.user.id).external_id, "g-123");

  // data is scoped to the new user
  assert.equal((await t.post("/api/v1/playlists", { name: "Mine" }, { cookie: session })).status, 201);
  assert.equal(t.db.prepare("SELECT count(*) n FROM playlists WHERE user_id = 1").get().n, 0);

  // second login maps to the same user
  const again = await login();
  assert.equal((await t.get("/api/v1/me", { cookie: again.session })).json.user.id, me.json.user.id);

  const out = await raw("/api/v1/auth/logout", {}, "POST");
  assert.equal(out.status, 200);
  assert.match(out.headers.getSetCookie().join(), /aq_session=;.*Expires=Thu, 01 Jan 1970/i);
});

test("callback rejects missing/forged state", async () => {
  assert.equal((await raw("/api/v1/auth/google/callback?code=abc&state=x")).status, 400);
  const r1 = await raw("/api/v1/auth/google/login");
  const sc = cookieOf(r1, "aq_oauth_state");
  assert.equal((await raw("/api/v1/auth/google/callback?code=abc&state=" + "0".repeat(32), { cookie: sc })).status, 400);
  assert.equal(google.calls.length, 0);
});

test("callback rejects bad id_tokens (wrong audience, unverified email, token error)", async () => {
  google.info.aud = "someone-else";
  assert.equal((await login()).r2.status, 401);
  google.info.aud = G.clientId; google.info.email_verified = "false";
  assert.equal((await login()).r2.status, 401);
  google.info.email_verified = true; google.tokenOk = false;
  const { r2, session } = await login();
  assert.equal(r2.status, 401);
  assert.equal(session, undefined);
});

test("tampered or foreign session cookies are rejected", async () => {
  const { session } = await login();
  const [p, sig] = session.split("=")[1].split(".");
  const forged = Buffer.from(JSON.stringify({ uid: 1, exp: Date.now() + 1e6 })).toString("base64url");
  assert.equal((await t.get("/api/v1/me", { cookie: `aq_session=${forged}.${sig}` })).status, 401);
  assert.equal((await t.get("/api/v1/me", { cookie: `aq_session=${p}.AAAA` })).status, 401);
});

test("google mode refuses to start without credentials / secret", async () => {
  const { loadConfig } = await import("../src/config.js");
  const { createApp } = await import("../src/app.js");
  assert.throws(() => createApp(loadConfig({ AUTH_MODE: "google" }, { dbFile: ":memory:", uiDir: "" })), /SESSION_SECRET/);
  assert.equal(loadConfig({}).authMode, "local");
});

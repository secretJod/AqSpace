// #62 (web-dev-3): a smart-playlist run through aq-api as the Cloudflare tunnel delivers it (loopback, Host
// localhost:<port>, cf-* / x-forwarded-* headers). /api/v1 smart routes work, the heavy and general rate limits still
// apply (and a spoofed cf-connecting-ip cannot dodge them), and /dev stays 404. Fake worker only, no network.
import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { startApp, VID, JOB } from "./helpers.js";

const TUNNEL = { "cf-connecting-ip": "203.0.113.9", "cf-ray": "8abc-LHR", "cdn-loop": "cloudflare",
  "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "cf-visitor": '{"scheme":"https"}', "cf-ipcountry": "GB" };

/** Raw request with the tunnel's Host rewrite (fetch would not let us set Host). */
function req(base, method, p, body, headers = {}) {
  const { port } = new URL(base);
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((res, rej) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method,
      headers: { Host: `localhost:${port}`, ...TUNNEL, ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers } },
    (x) => { let t = ""; x.on("data", (c) => (t += c)); x.on("end", () => { let json = null; try { json = JSON.parse(t); } catch { /* not json */ } res({ status: x.statusCode, json, headers: x.headers }); }); });
    r.on("error", rej);
    r.end(data);
  });
}

function fakeWorker() {
  const w = { created: [], jobs: new Map(), next: 1 };
  const reply = (code, o) => new Response(JSON.stringify(o), { status: code, headers: { "content-type": "application/json" } });
  w.fetch = async (url, init = {}) => {
    const p = new URL(url).pathname, method = init.method || "GET";
    let m;
    if (method === "POST" && p === "/api/smart") {
      const id = JOB(w.next++);
      w.created.push({ id, body: JSON.parse(init.body) });
      w.jobs.set(id, { status: "running", pct: 25, stage: "profiling", message: "Profiling" });
      return reply(202, { job_id: id });
    }
    if (method === "GET" && (m = /^\/api\/smart\/([a-f0-9]{32})$/.exec(p))) {
      const j = w.jobs.get(m[1]);
      return j ? reply(200, j) : reply(404, { error: "Job not found" });
    }
    return reply(404, { error: "nope" });
  };
  return w;
}

const RESULT = (ids) => ({
  goal: "Goal", path_summary: "Start with the basics.", order: ids.map((id) => ({ video_id: id, reason: "why" })),
  unplaced: [], off_goal: [], areas: [], suggestions: [], video_topics: {}, checks: ["ok"], stats: { topics_claimed: 1, topics_grounded: 1 }
});
const S = "/api/v1/playlists/goal/smart";
const PLAYLIST = { id: "goal", name: "Goal", videos: [{ id: VID(1), title: "one" }, { id: VID(2), title: "two" }] };

test("smart run through the tunnel: start -> poll -> ready, and /dev is still 404", async () => {
  const w = fakeWorker();
  const t = await startApp({ fetchImpl: w.fetch });
  try {
    assert.equal((await req(t.base, "POST", "/api/v1/playlists", PLAYLIST)).status, 201);
    let r = await req(t.base, "POST", S);
    assert.equal(r.status, 202, JSON.stringify(r.json));
    assert.equal(w.created.length, 1);
    assert.equal(w.created[0].body.goal, "Goal");
    r = await req(t.base, "GET", S);
    assert.equal(r.status, 200);
    assert.equal(r.json.state, "running");
    Object.assign(w.jobs.get(JOB(1)), { status: "done", pct: 100, result: RESULT([VID(1), VID(2)]) });
    r = await req(t.base, "GET", S);
    assert.equal(r.json.state, "ready");
    assert.deepEqual(r.json.result.order.map((o) => o.video_id), [VID(1), VID(2)]);
    for (const p of ["/dev", "/dev/", "/dev/api/overview", "/dev/api/jobs"]) {
      assert.equal((await req(t.base, "GET", p)).status, 404, p);
    }
    // the same /dev path from the machine itself (no proxy headers) is reachable, so the 404 above is the tunnel guard
    assert.equal((await t.get("/dev/api/overview", { host: new URL(t.base).host })).status, 200);
  } finally { await t.close(); }
});

test("through the tunnel the heavy limit applies to smart starts, and rotating cf-connecting-ip does not reset it", async () => {
  const w = fakeWorker();
  const t = await startApp({ fetchImpl: w.fetch, overrides: { rate: { general: { max: 100000, windowMs: 60000 }, heavy: { max: 2, windowMs: 60000 } } } });
  try {
    assert.equal((await req(t.base, "POST", "/api/v1/playlists", PLAYLIST)).status, 201);
    assert.equal((await req(t.base, "POST", S, undefined, { "cf-connecting-ip": "198.51.100.1" })).status, 202);
    const second = await req(t.base, "POST", S, undefined, { "cf-connecting-ip": "198.51.100.2" });
    assert.notEqual(second.status, 429);
    const third = await req(t.base, "POST", S, undefined, { "cf-connecting-ip": "198.51.100.3", "x-forwarded-for": "198.51.100.3" });
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers["retry-after"]) >= 1);
    // GET status is not a heavy route: still served
    assert.equal((await req(t.base, "GET", S)).status, 200);
  } finally { await t.close(); }
});

test("through the tunnel the general limit applies to every /api/v1 call", async () => {
  const t = await startApp({ fetchImpl: fakeWorker().fetch, overrides: { rate: { general: { max: 3, windowMs: 60000 }, heavy: { max: 100, windowMs: 60000 } } } });
  try {
    for (let i = 0; i < 3; i++) assert.notEqual((await req(t.base, "GET", S)).status, 429);
    const r = await req(t.base, "GET", "/api/v1/playlists", undefined, { "cf-connecting-ip": "192.0.2.77" });
    assert.equal(r.status, 429);
  } finally { await t.close(); }
});

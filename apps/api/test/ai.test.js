/* ai.test.js - the signed-in user's own AI keys: encryption (services/key-box.js), the /api/v1/ai routes
   (services/ai-keys-service.js) and how notes jobs pick up the key. Uses a mock worker and fake keys only. */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startApp, startMockPython, VID, TEST_KEY_SECRET } from "./helpers.js";
import { createKeyBox } from "../src/services/key-box.js";

// Fake keys only (right shape, never real).
const GROQ_KEY = "gsk_FAKEtestKEY0123456789abcdefWXYZ";
const GEMINI_KEY = "AIzaFAKEtestKEY0123456789abcdQRST";
const A = "/api/v1/ai";

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

test("key box: AES-256-GCM round trip, fresh IV each time, tamper / wrong row / wrong secret detected", () => {
  const box = createKeyBox({ secret: TEST_KEY_SECRET });
  const a = box.encrypt(GROQ_KEY, "1:groq"),
    b = box.encrypt(GROQ_KEY, "1:groq");
  assert.equal(a.iv.length, 12);
  assert.equal(a.tag.length, 16);
  assert.notDeepEqual(a.iv, b.iv);
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
  assert.ok(!a.ciphertext.toString("latin1").includes(GROQ_KEY));
  assert.equal(box.decrypt(a, "1:groq"), GROQ_KEY);

  const flip = (buf) => {
    const c = Buffer.from(buf);
    c[0] ^= 1;
    return c;
  };
  assert.throws(() => box.decrypt({ ...a, ciphertext: flip(a.ciphertext) }, "1:groq"));
  assert.throws(() => box.decrypt({ ...a, tag: flip(a.tag) }, "1:groq"));
  assert.throws(() => box.decrypt({ ...a, iv: flip(a.iv) }, "1:groq"));
  assert.throws(() => box.decrypt(a, "2:groq")); // another user's row
  assert.throws(() => createKeyBox({ secret: Buffer.alloc(32, 9).toString("base64") }).decrypt(a, "1:groq"));
  assert.throws(() => createKeyBox({ secret: "dG9vLXNob3J0" }), /32 bytes/); // bad AQ_KEY_SECRET stops start-up
});

test("key box: the secret file is created once (lazily) and reused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aq-keysecret-"));
  try {
    const file = path.join(dir, "sub", ".key-secret");
    const box1 = createKeyBox({ secretFile: file });
    assert.equal(fs.existsSync(file), false); // nothing until a key is stored
    const sealed = box1.encrypt(GROQ_KEY, "x");
    const content = fs.readFileSync(file, "utf8");
    assert.equal(Buffer.from(content.trim(), "base64").length, 32);
    const box2 = createKeyBox({ secretFile: file });
    assert.equal(box2.decrypt(sealed, "x"), GROQ_KEY);
    assert.equal(fs.readFileSync(file, "utf8"), content); // not rewritten
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

let py, t;
const seen = []; // every response text, to check for leaks
const track = (r) => {
  seen.push(r.text);
  return r;
};
beforeEach(async () => {
  seen.length = 0;
  py = await startMockPython();
  t = await startApp({
    py,
    authenticate: (req, _res, next) => {
      req.user = { id: Number(req.headers["x-user"] || 1), name: "u" };
      next();
    }
  });
  t.db.exec("INSERT INTO users (id, name) VALUES (2, 'b')");
  await t.post("/api/v1/playlists", { name: "L", videos: [{ id: VID(1) }, { id: VID(2) }, { id: VID(3) }] });
});
afterEach(async () => {
  for (const text of seen) {
    assert.ok(!text.includes(GROQ_KEY) && !text.includes(GEMINI_KEY), "a response leaked a key");
  }
  await t.close();
  await py.close();
});

test("GET /ai: provider metadata, nothing connected, server-key flags and task defaults", async () => {
  py.state.serverKeys = { gemini: false, groq: true, nvidia: false, xai: false, huggingface: false };
  const r = track(await t.get(A));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    r.json.providers.map((p) => p.id),
    ["gemini", "groq", "nvidia", "xai", "huggingface"]
  );
  assert.deepEqual(r.json.providers[1], {
    id: "groq",
    label: "Groq",
    prefix: "gsk_",
    keyUrl: "https://console.groq.com/keys",
    connected: false,
    last4: null,
    status: "missing",
    checkedAt: null,
    serverKey: true
  });
  assert.equal(r.json.providers[0].keyUrl, "https://aistudio.google.com/app/apikey");
  assert.deepEqual(Object.keys(r.json.tasks), ["notes", "smart", "assistant", "doubts"]);
  assert.equal(r.json.tasks.notes.provider, "groq");
  assert.equal(r.json.tasks.notes.ready, true); // server key
  assert.equal(r.json.tasks.smart.provider, "gemini");
  assert.equal(r.json.tasks.smart.ready, false);
  assert.equal(r.json.tasks.assistant.provider, "groq");
  assert.equal(r.json.tasks.doubts.provider, "nvidia");
  assert.equal(r.json.tasks.doubts.ready, false);
});

test("GET /ai: an unreachable worker means no server keys (not an error)", async () => {
  await py.close();
  const r = await t.get(A);
  assert.equal(r.status, 200);
  assert.ok(r.json.providers.every((p) => p.serverKey === false));
});

test("PUT key: tested by the worker, stored encrypted, only last4 ever returned", async () => {
  py.state.serverKeys = {};
  let r = track(await t.put(`${A}/keys/groq`, { key: GROQ_KEY }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { provider: "groq", connected: true, last4: "WXYZ", status: "ok" });
  assert.deepEqual(py.state.keyTests, [{ provider: "groq", api_key: GROQ_KEY }]);

  const row = t.db.prepare("SELECT * FROM ai_keys WHERE user_id = 1 AND provider = 'groq'").get();
  assert.equal(row.last4, "WXYZ");
  for (const col of ["ciphertext", "iv", "tag"])
    assert.ok(!Buffer.from(row[col]).toString("latin1").includes(GROQ_KEY));
  assert.ok(
    !JSON.stringify(t.db.prepare("SELECT * FROM ai_keys").all(), (_k, v) =>
      v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v
    ).includes(GROQ_KEY)
  );

  r = track(await t.get(A));
  const groq = r.json.providers.find((p) => p.id === "groq");
  assert.equal(groq.connected, true);
  assert.equal(groq.last4, "WXYZ");
  assert.equal(groq.status, "ok");
  assert.equal(typeof groq.checkedAt, "string");
  assert.equal(r.json.tasks.notes.ready, true);
  assert.equal(r.json.tasks.assistant.ready, true);

  // keys are per user
  r = track(await t.get(A, { "x-user": "2" }));
  assert.equal(r.json.providers.find((p) => p.id === "groq").connected, false);

  // replacing works (upsert)
  r = track(await t.put(`${A}/keys/groq`, { key: GROQ_KEY.slice(0, -4) + "ABCD" }));
  assert.equal(r.json.last4, "ABCD");
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM ai_keys").get().n, 1);

  // dev tracker never records bodies
  const dev = track(await t.get("/dev/api/requests?since=0&limit=500"));
  assert.ok(dev.json.items.some((e) => e.path === "/api/v1/ai/keys/groq"));
});

test("PUT key: invalid -> 400 {error, kind} not saved; bad format / unknown provider -> 400; worker down -> 502", async () => {
  let r = track(await t.put(`${A}/keys/groq`, { key: "gsk_BADkey0123456789abcdefghij" }));
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "That key was rejected by the provider.", kind: "invalid" });
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM ai_keys").get().n, 0);

  // the worker's message never echoes the key, even if it contained it
  py.state.keyTestAnswer = (b) => ({ ok: false, kind: "quota", error: "Quota used up for " + b.api_key });
  r = track(await t.put(`${A}/keys/groq`, { key: GROQ_KEY }));
  assert.equal(r.status, 400);
  assert.equal(r.json.kind, "quota");
  assert.ok(!r.text.includes(GROQ_KEY));
  py.state.keyTestAnswer = () => ({ ok: true });

  const tests = py.state.keyTests.length;
  for (const key of ["short", "has spaces in it 0123456789", "x".repeat(201), 1234567890123456, ""]) {
    r = await t.put(`${A}/keys/groq`, { key });
    assert.equal(r.status, 400, String(key));
  }
  assert.equal((await t.put(`${A}/keys/groq`, {})).status, 400);
  assert.equal((await t.put(`${A}/keys/colab`, { key: GROQ_KEY })).status, 400);
  assert.equal((await t.put(`${A}/keys/nope`, { key: GROQ_KEY })).status, 400);
  assert.equal(py.state.keyTests.length, tests); // none of these reached the worker

  await py.close();
  r = track(await t.put(`${A}/keys/groq`, { key: GROQ_KEY }));
  assert.equal(r.status, 502);
  assert.equal(r.json.code, "py_offline");
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM ai_keys").get().n, 0);
});

test("POST test re-checks the stored key; DELETE removes it", async () => {
  assert.equal((await t.post(`${A}/keys/groq/test`)).status, 404);
  track(await t.put(`${A}/keys/groq`, { key: GROQ_KEY }));
  let r = track(await t.post(`${A}/keys/groq/test`));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { provider: "groq", connected: true, last4: "WXYZ", status: "ok" });
  assert.equal(py.state.keyTests.at(-1).api_key, GROQ_KEY); // the decrypted key went to the worker

  py.state.keyTestAnswer = () => ({ ok: false, kind: "invalid", error: "Key revoked." });
  r = track(await t.post(`${A}/keys/groq/test`));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    provider: "groq",
    connected: true,
    last4: "WXYZ",
    status: "failing",
    error: "Key revoked.",
    kind: "invalid"
  });
  assert.equal(track(await t.get(A)).json.providers.find((p) => p.id === "groq").status, "failing");

  assert.equal((await t.del(`${A}/keys/groq`, { "x-user": "2" })).status, 204); // other user: nothing happens
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM ai_keys").get().n, 1);
  assert.equal((await t.del(`${A}/keys/groq`)).status, 204);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM ai_keys").get().n, 0);
  assert.equal(track(await t.get(A)).json.providers.find((p) => p.id === "groq").status, "missing");
  assert.equal((await t.del(`${A}/keys/nope`)).status, 400);
});

test("PUT /ai/tasks/:task chooses the provider; null goes back to the default", async () => {
  py.state.serverKeys = {};
  let r = await t.put(`${A}/tasks/notes`, { provider: "gemini" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { task: "notes", provider: "gemini", ready: false, default: "groq" });
  track(await t.put(`${A}/keys/gemini`, { key: GEMINI_KEY }));
  assert.equal(track(await t.get(A)).json.tasks.notes.ready, true);
  assert.equal(track(await t.get(A, { "x-user": "2" })).json.tasks.notes.provider, "groq"); // per user

  assert.equal((await t.put(`${A}/tasks/nope`, { provider: "groq" })).status, 400);
  assert.equal((await t.put(`${A}/tasks/notes`, { provider: "colab" })).status, 400);
  assert.equal((await t.put(`${A}/tasks/notes`, {})).status, 400);
  r = await t.put(`${A}/tasks/notes`, { provider: null });
  assert.equal(r.json.provider, "groq");
});

test("notes start: sends the user's key, falls back to the server key, else 409 ai_key_required", async () => {
  const N = "/api/v1/notes/";
  // 1. no user key, server key exists -> no api_key
  let r = await t.post(N + VID(1));
  assert.equal(r.status, 202);
  assert.equal(py.state.jobsCreated[0].body.provider, "groq");
  assert.equal("api_key" in py.state.jobsCreated[0].body, false);

  // 2. user key -> sent as api_key
  track(await t.put(`${A}/keys/groq`, { key: GROQ_KEY }));
  r = track(await t.post(N + VID(2)));
  assert.equal(r.status, 202);
  assert.equal(py.state.jobsCreated[1].body.api_key, GROQ_KEY);

  // 3. user override wins over config.pyProvider
  await t.put(`${A}/tasks/notes`, { provider: "gemini" });
  track(await t.put(`${A}/keys/gemini`, { key: GEMINI_KEY }));
  r = track(await t.post(N + VID(3)));
  assert.equal(r.status, 202);
  assert.equal(py.state.jobsCreated[2].body.provider, "gemini");
  assert.equal(py.state.jobsCreated[2].body.api_key, GEMINI_KEY);

  // 4. neither -> 409, no job; cached notes still need no key
  await t.del(`${A}/keys/gemini`);
  py.state.serverKeys = {};
  const fresh = await startApp({ py }); // new app = empty server-key cache
  try {
    await fresh.post("/api/v1/playlists", { name: "L", videos: [{ id: VID(4) }] });
    await fresh.put(`${A}/tasks/notes`, { provider: "gemini" });
    r = await fresh.post(N + VID(4));
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, {
      error: "Connect Google Gemini to use this feature.",
      code: "ai_key_required",
      provider: "gemini",
      task: "notes"
    });
    assert.equal(py.state.jobsCreated.length, 3);
    assert.equal(fresh.db.prepare("SELECT COUNT(*) AS n FROM notes_jobs").get().n, 0);
  } finally {
    await fresh.close();
  }
});

test("server-key lookups are cached (~60s)", async () => {
  await t.get(A);
  await t.get(A);
  await t.post("/api/v1/notes/" + VID(1));
  assert.equal(py.state.hits.providers, 1);
});

test("keys never reach the console log (request logger on)", async () => {
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => logged.push(a.join(" "));
  const loud = await startApp({ py, overrides: { log: true } });
  try {
    await loud.put(`${A}/keys/groq`, { key: GROQ_KEY });
    await loud.put(`${A}/keys/groq`, { key: "gsk_BADkey0123456789abcdefghij" });
    await loud.post(`${A}/keys/groq/test`);
    await loud.put(`${A}/keys/groq`, `{"key":"${GROQ_KEY}"`); // broken JSON
  } finally {
    Object.assign(console, orig);
    await loud.close();
  }
  assert.ok(logged.some((l) => l.includes("PUT /api/v1/ai/keys/groq 200")));
  assert.ok(logged.every((l) => !l.includes(GROQ_KEY) && !l.includes("BADkey")));
});

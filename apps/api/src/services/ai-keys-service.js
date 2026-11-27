/* ai-keys-service.js - each user's own AI provider keys and their task -> provider choices.

   What:  - stores a user's API key per provider, encrypted (key-box.js), after the worker
            confirmed it works (POST {pyUrl}/api/keys/test);
          - remembers which provider the user wants for each task (notes / smart / assistant / doubts);
          - resolve(user, task) picks the provider and key for a job: the user's own key, else the
            worker's server key (GET {pyUrl}/api/providers, cached), else a 409 "ai_key_required".
   Ownership: every query is scoped to user.id. A key is only ever decrypted for its owner's own job
          (notes-service and smart-service pass the job owner), never shared across users.
   Safety: a key is decrypted only inside resolve(), right before it is sent to the worker.
          Nothing returned to clients ever contains key material except `last4`.
          Keys never go into URLs, logs or error messages.
   How it fits: created in app.js; used by routes/ai.js and by the notes / smart services.
   Read next: routes/ai.js */
import { HttpError, bad, notFound } from "../utils/http-errors.js";
import { isObj } from "../utils/validate.js";
import { nowIso } from "../utils/time.js";
import { short } from "./job-helpers.js";
import { createKeyBox } from "./key-box.js";

// ---------------------------------------------------------------------------
// 1. Providers and tasks
// ---------------------------------------------------------------------------

/** Providers that support BYOK, in display order. `prefix` is only a hint (format checks accept any key shape). */
export const PROVIDERS = [
  { id: "gemini", label: "Google Gemini", prefix: "AIza", keyUrl: "https://aistudio.google.com/app/apikey" },
  { id: "groq", label: "Groq", prefix: "gsk_", keyUrl: "https://console.groq.com/keys" },
  { id: "nvidia", label: "NVIDIA Nemotron", prefix: "nvapi-", keyUrl: "https://build.nvidia.com/settings/api-keys" },
  { id: "xai", label: "xAI Grok", prefix: "xai-", keyUrl: "https://console.x.ai" },
  { id: "huggingface", label: "Hugging Face", prefix: "hf_", keyUrl: "https://huggingface.co/settings/tokens" }
];
const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));
/** Tasks a user can pick a provider for. */
export const TASKS = ["notes", "smart", "assistant", "doubts"];
/** What a pasted key must look like before it is even tested (no spaces, sensible length). */
export const KEY_RE = /^[A-Za-z0-9_\-.]{20,200}$/;

const isProvider = (id) => typeof id === "string" && BY_ID.has(id);

// ---------------------------------------------------------------------------
// 2. The service
// ---------------------------------------------------------------------------

/**
 * Builds the AI keys service.
 *
 * @param {object} deps
 * @param {import("node:sqlite").DatabaseSync} deps.db
 * @param {object} deps.py      the worker client (services/worker-client.js)
 * @param {object} deps.config  uses keySecret / keySecretFile, ai timings, pyProvider and pySmartProvider
 * @param {() => number} [deps.clock]  current time in ms
 * @returns {object} overview, saveKey, retestKey, deleteKey, setTaskProvider, resolve, providerFor, defaults
 */
export function createAiKeysService({ db, py, config, clock = Date.now }) {
  const box = createKeyBox({ secret: config.keySecret, secretFile: config.keySecretFile });
  const ai = config.ai;
  const defaults = { notes: config.pyProvider, smart: config.pySmartProvider, assistant: "groq", doubts: "nvidia" };

  // ---- rows ----------------------------------------------------------------

  const keyRow = (userId, provider) =>
    db.prepare("SELECT * FROM ai_keys WHERE user_id = ? AND provider = ?").get(userId, provider) || null;
  const keyRows = (userId) =>
    new Map(
      db
        .prepare("SELECT provider, last4, status, checked_at FROM ai_keys WHERE user_id = ?")
        .all(userId)
        .map((r) => [r.provider, r])
    );
  const overrides = (userId) =>
    new Map(
      db
        .prepare("SELECT task, provider FROM ai_task_providers WHERE user_id = ?")
        .all(userId)
        .map((r) => [r.task, r.provider])
    );
  const aadOf = (userId, provider) => `${userId}:${provider}`;
  const providerFor = (userId, task) => overrides(userId).get(task) || defaults[task];

  // ---- worker: which providers have a server key (cached) ------------------

  let serverKeyCache = null; // { at, flags: Map(id -> bool) }

  /** Map provider id -> the worker has its own key. Cached for ai.providersCacheMs.
      A failed lookup means "no server keys" (not cached); with throwOffline, an unreachable worker throws its 503. */
  async function serverKeys({ throwOffline = false } = {}) {
    if (serverKeyCache && clock() - serverKeyCache.at < ai.providersCacheMs) return serverKeyCache.flags;
    let answer;
    try {
      answer = await py.json("/api/providers", { timeout: ai.providersTimeoutMs });
    } catch (e) {
      if (throwOffline) throw e;
      return new Map();
    }
    if (answer.status !== 200 || !isObj(answer.json) || !Array.isArray(answer.json.providers)) return new Map();
    const flags = new Map(answer.json.providers.filter(isObj).map((p) => [String(p.id), p.server_key === true]));
    serverKeyCache = { at: clock(), flags };
    return flags;
  }

  // ---- worker: test a key --------------------------------------------------

  /** -> {ok: true} | {ok: false, kind, error}. Throws 502 (worker unreachable / broken), 429 or 400 (bad input). */
  async function testWithWorker(provider, key) {
    let answer;
    try {
      answer = await py.json("/api/keys/test", {
        method: "POST",
        timeout: ai.testTimeoutMs,
        body: { provider, api_key: key }
      });
    } catch {
      throw new HttpError(
        502,
        "The AI service is not running, so the key could not be tested. Start it and try again.",
        { code: "py_offline" }
      );
    }
    // Belt and braces: the worker redacts keys itself, but never echo one back from here either.
    const clean = (s, fallback) =>
      short(
        String(s || fallback)
          .split(key)
          .join("[key]"),
        300
      );
    if (answer.status === 429)
      throw new HttpError(429, "Too many key tests. Wait a moment and try again.", { retryAfter: 10 });
    if (answer.status === 400) throw bad(clean(answer.json && answer.json.error, "The AI service refused that key."));
    if (answer.status !== 200 || !isObj(answer.json))
      throw new HttpError(502, `The AI service answered with status ${answer.status}.`);
    if (answer.json.ok === true) return { ok: true };
    const kind = ["invalid", "quota", "network", "other"].includes(answer.json.kind) ? answer.json.kind : "other";
    return { ok: false, kind, error: clean(answer.json.error, "The key did not work.") };
  }

  // ---- public views ----------------------------------------------------------

  const keyView = (provider, row) => ({ provider, connected: true, last4: row.last4, status: row.status });

  /** GET /ai: providers (no key material except last4) + which provider does each task and whether it is ready. */
  async function overview(user) {
    const rows = keyRows(user.id);
    const flags = await serverKeys();
    const providers = PROVIDERS.map((p) => {
      const row = rows.get(p.id);
      return {
        id: p.id,
        label: p.label,
        prefix: p.prefix,
        keyUrl: p.keyUrl,
        connected: !!row,
        last4: row ? row.last4 : null,
        status: row ? row.status : "missing",
        checkedAt: row ? row.checked_at : null,
        serverKey: flags.get(p.id) === true
      };
    });
    const chosen = overrides(user.id);
    const tasks = {};
    for (const task of TASKS) {
      const provider = chosen.get(task) || defaults[task];
      // A provider outside the BYOK list (e.g. colab) cannot take a user key: the worker handles it.
      const ready = !isProvider(provider) || rows.has(provider) || flags.get(provider) === true;
      tasks[task] = { provider, ready, default: defaults[task] };
    }
    return { providers, tasks };
  }

  // ---- keys ------------------------------------------------------------------

  function checkProvider(provider) {
    if (!isProvider(provider)) throw bad("Unknown AI provider.");
    return provider;
  }

  /** PUT /ai/keys/:provider - test, then encrypt + save. A key that fails the test is NOT saved. */
  async function saveKey(user, provider, body) {
    checkProvider(provider);
    const key = isObj(body) && typeof body.key === "string" ? body.key.trim() : "";
    if (!KEY_RE.test(key)) throw bad("That does not look like an API key. Copy the whole key and paste it again.");
    const result = await testWithWorker(provider, key);
    if (!result.ok) throw new HttpError(400, result.error, { details: { kind: result.kind } });

    const sealed = box.encrypt(key, aadOf(user.id, provider));
    const now = nowIso();
    db.prepare(
      `INSERT INTO ai_keys (user_id, provider, ciphertext, iv, tag, last4, status, checked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?)
       ON CONFLICT (user_id, provider) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
         last4 = excluded.last4, status = 'ok', checked_at = excluded.checked_at, updated_at = excluded.updated_at`
    ).run(user.id, provider, sealed.ciphertext, sealed.iv, sealed.tag, key.slice(-4), now, now, now);
    return keyView(provider, keyRow(user.id, provider));
  }

  /** POST /ai/keys/:provider/test - re-test the stored key; updates status + checked_at.
      A key that no longer works -> 200 with status "failing" plus {error, kind}. */
  async function retestKey(user, provider) {
    checkProvider(provider);
    const row = keyRow(user.id, provider);
    if (!row) throw notFound("No key is saved for this provider.");
    const key = decryptRow(user.id, row);
    const result = await testWithWorker(provider, key);
    const status = result.ok ? "ok" : "failing";
    db.prepare("UPDATE ai_keys SET status = ?, checked_at = ?, updated_at = ? WHERE user_id = ? AND provider = ?").run(
      status,
      nowIso(),
      nowIso(),
      user.id,
      provider
    );
    const out = keyView(provider, keyRow(user.id, provider));
    return result.ok ? out : { ...out, error: result.error, kind: result.kind };
  }

  /** DELETE /ai/keys/:provider (no error when there was none). */
  function deleteKey(user, provider) {
    checkProvider(provider);
    db.prepare("DELETE FROM ai_keys WHERE user_id = ? AND provider = ?").run(user.id, provider);
  }

  function decryptRow(userId, row) {
    try {
      return box.decrypt(row, aadOf(userId, row.provider));
    } catch {
      // wrong master secret or a damaged row: never log details (they could hint at the key)
      throw new HttpError(
        500,
        `The saved ${BY_ID.get(row.provider).label} key could not be read. Remove it and connect it again.`
      );
    }
  }

  // ---- tasks -----------------------------------------------------------------

  /** PUT /ai/tasks/:task {provider}. provider null / "" = back to the default. */
  async function setTaskProvider(user, task, body) {
    if (!TASKS.includes(task)) throw bad("Unknown AI task.");
    const provider = isObj(body) ? body.provider : undefined;
    if (provider === null || provider === "") {
      db.prepare("DELETE FROM ai_task_providers WHERE user_id = ? AND task = ?").run(user.id, task);
    } else {
      checkProvider(provider);
      db.prepare(
        `INSERT INTO ai_task_providers (user_id, task, provider, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, task) DO UPDATE SET provider = excluded.provider, updated_at = excluded.updated_at`
      ).run(user.id, task, provider, nowIso());
    }
    const { tasks } = await overview(user);
    return { task, ...tasks[task] };
  }

  // ---- key resolution for jobs ----------------------------------------------

  /** Which provider and key to use for a task. -> { provider, apiKey } (apiKey null = the worker's own key).
      Throws 409 {code: "ai_key_required", provider, task} when there is no usable key,
      or the worker's 503 when it cannot be reached. */
  async function resolve(user, task) {
    const provider = providerFor(user.id, task);
    if (!isProvider(provider)) return { provider, apiKey: null };
    const row = keyRow(user.id, provider);
    if (row) return { provider, apiKey: decryptRow(user.id, row) };
    const flags = await serverKeys({ throwOffline: true });
    if (flags.get(provider) === true) return { provider, apiKey: null };
    throw new HttpError(409, `Connect ${BY_ID.get(provider).label} to use this feature.`, {
      code: "ai_key_required",
      details: { provider, task }
    });
  }

  return { overview, saveKey, retestKey, deleteKey, setTaskProvider, resolve, providerFor, defaults };
}

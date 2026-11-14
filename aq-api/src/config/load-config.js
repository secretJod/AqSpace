/* load-config.js - every setting of the API in one place.

   What:  reads environment variables once and returns a plain `config` object.
   How it fits: server.js calls loadConfig() and passes the result to createApp();
          tests call loadConfig({}, overrides) to change settings.
   Read next: app.js */
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 1. Paths
// ---------------------------------------------------------------------------

// The aq-api folder (this file lives in aq-api/src/config/).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// 2. Helpers
// ---------------------------------------------------------------------------

/** Whole number >= 0 from an env string, or the default `fallback`. */
function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// 3. The config object
// ---------------------------------------------------------------------------

/** Reads the environment once. `overrides` is for tests. */
export function loadConfig(env = process.env, overrides = {}) {
  const config = {
    host: "127.0.0.1",                                   // never configurable: this is a local-only service
    port: int(env.PORT, 5180),
    dbFile: env.DB_FILE || path.join(ROOT, "data", "aq.db"),
    sqlDir: path.join(ROOT, "sql"),
    uiDir: env.UI_DIR || path.resolve(ROOT, "..", "lecture-notes-ui"),

    // The Python worker (notes + AI)
    pyUrl: (env.PY_NOTES_URL || "http://127.0.0.1:5055").replace(/\/+$/, ""),
    pyProvider: env.PY_NOTES_PROVIDER || "groq",
    pySmartProvider: env.PY_SMART_PROVIDER || "gemini",   // provider for smart playlist runs
    pySmartModel: env.PY_SMART_MODEL || "",               // "" = the worker's default model for that provider
    allowRemotePy: env.ALLOW_REMOTE_PY === "1",
    requireMembership: env.NOTES_REQUIRE_MEMBERSHIP !== "0",   // notes can only be started for videos in the user's playlists

    // HTTP
    bodyLimit: env.BODY_LIMIT || "256kb",
    log: env.LOG !== "0",

    // Developer tools (/dev)
    devTools: env.AQ_DEV_TOOLS !== "0",                  // /dev tracker (local only); AQ_DEV_TOOLS=0 turns it off (404)
    devLogDir: env.AQ_DEVLOG_DIR ?? path.join(ROOT, "data", "devlogs"),   // persistent tracker JSONL; "" = off
    devLogDays: int(env.AQ_DEVLOG_DAYS, 14),
    runDir: env.AQ_RUN_DIR ?? path.resolve(ROOT, "..", ".run"),          // start-all.ps1 service console logs

    // Rate limits, per client IP, fixed window
    rate: {
      general: { max: int(env.RATE_LIMIT_PER_MIN, 600), windowMs: 60_000 },
      heavy: { max: int(env.RATE_LIMIT_HEAVY_PER_MIN, 20), windowMs: 60_000 }   // starting notes / YouTube imports
    },

    // Timings for talking to the worker
    notes: { pollMinMs: 800, verifyMs: 5 * 60_000, pyTimeoutMs: 10_000, importTimeoutMs: 60_000 }
  };
  return Object.assign(config, overrides);
}

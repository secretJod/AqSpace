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

// The API app folder (this file lives in apps/api/src/config/).
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

/**
 * Reads the environment once and returns the settings object used everywhere else.
 * The README lists every variable; TUNNEL_ORIGINS is read by middleware/local-only.js.
 *
 * @param {Record<string, string | undefined>} [env]  the environment (default process.env)
 * @param {object} [overrides]  top-level keys to replace afterwards (tests use this)
 * @returns {object} the config: host, port, paths, worker settings, limits, sign-in and timings
 */
export function loadConfig(env = process.env, overrides = {}) {
  const config = {
    // Loopback by default. HOST=0.0.0.0 is only for inside the container, where compose publishes the port
    // on 127.0.0.1 only, so the API is never reachable from the network directly.
    host: env.HOST || "127.0.0.1",
    port: int(env.PORT, 5180),
    dbFile: env.DB_FILE || path.join(ROOT, "data", "aq.db"),
    sqlDir: path.join(ROOT, "sql"),
    uiDir: env.UI_DIR || path.resolve(ROOT, "..", "web"),

    // The Python worker (transcripts, notes, language-model calls)
    pyUrl: (env.PY_NOTES_URL || "http://127.0.0.1:5055").replace(/\/+$/, ""),
    pyProvider: env.PY_NOTES_PROVIDER || "groq",
    pySmartProvider: env.PY_SMART_PROVIDER || "gemini", // provider for smart playlist runs
    pySmartModel: env.PY_SMART_MODEL || "", // "" = the worker's default model for that provider
    allowRemotePy: env.ALLOW_REMOTE_PY === "1",
    requireMembership: env.NOTES_REQUIRE_MEMBERSHIP !== "0", // notes can only be started for videos in the user's playlists

    // HTTP
    bodyLimit: env.BODY_LIMIT || "256kb",
    log: env.LOG !== "0",

    // Developer tools (/dev)
    devTools: env.AQ_DEV_TOOLS !== "0", // /dev tracker (local only); AQ_DEV_TOOLS=0 turns it off (404)
    devLogDir: env.AQ_DEVLOG_DIR ?? path.join(ROOT, "data", "devlogs"), // persistent tracker JSONL; "" = off
    devLogDays: int(env.AQ_DEVLOG_DAYS, 14),
    runDir: env.AQ_RUN_DIR ?? path.resolve(ROOT, "..", ".run"), // service console logs (<service>.out.log / .err.log); "" = off

    // Rate limits, per client IP, fixed window
    // Opt-in: give each tunnel visitor their own bucket via CF-Connecting-IP. Only honoured for proxied requests
    // that arrive from loopback (the local cloudflared), see clientKey() in middleware/rate-limit.js.
    trustCfHeaders: env.TRUST_CF_HEADERS === "1",
    rate: {
      general: { max: int(env.RATE_LIMIT_PER_MIN, 600), windowMs: 60_000 },
      heavy: { max: int(env.RATE_LIMIT_HEAVY_PER_MIN, 20), windowMs: 60_000 } // starting notes / YouTube imports
    },

    // Sign-in: local = single built-in user (default); google = Google OAuth (middleware/google-auth.js)
    authMode: env.AUTH_MODE === "google" ? "google" : "local",
    google: {
      clientId: env.GOOGLE_CLIENT_ID || "",
      clientSecret: env.GOOGLE_CLIENT_SECRET || "",
      redirectUri: env.GOOGLE_REDIRECT_URI || "http://localhost:5180/api/v1/auth/google/callback",
      sessionSecret: env.SESSION_SECRET || "",
      sessionMaxAgeMs: int(env.SESSION_MAX_AGE_HOURS, 24 * 7) * 3_600_000,
      afterLogin: env.AUTH_AFTER_LOGIN || "/",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      tokeninfoUrl: "https://oauth2.googleapis.com/tokeninfo"
    },

    // Timings for talking to the worker; maxAutoResumes = re-submits after the worker lost a job (restart)
    notes: {
      pollMinMs: 800,
      verifyMs: 5 * 60_000,
      pyTimeoutMs: 10_000,
      importTimeoutMs: 60_000,
      maxAutoResumes: int(env.NOTES_MAX_AUTO_RESUMES, 3)
    }
  };
  return Object.assign(config, overrides);
}

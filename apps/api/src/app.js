/* app.js - builds the Express app (but does not start listening; server.js does that).

   What:  creates the database, repository, worker client and services, then plugs the
          middleware and routers together in the right order.
   How it fits: server.js calls createApp(config); the tests call createApp(config, deps)
          with an in-memory database and a mock worker.
   A request goes through, in this order:
     1. security headers -> request logger -> host guard -> CORS
     2. dev tracker + /dev pages (when AQ_DEV_TOOLS is on; localOnly hides them from the tunnel)
     3. /api/v1 router (routes/index.js) -> service -> worker / database
     4. /static/fonts (from the worker), then the UI files
     5. 404, then the JSON error handler
   Read next: routes/index.js */
import express from "express";
import fs from "node:fs";
import { openDb } from "./db/database.js";
import { createRepo } from "./db/repository.js";
import { createPyClient, assertPyUrl } from "./services/worker-client.js";
import { createNotesService } from "./services/notes-service.js";
import { createSmartService } from "./services/smart-service.js";
import { createAiKeysService } from "./services/ai-keys-service.js";
import { createAssistantService } from "./services/assistant-service.js";
import { localAuth, LOCAL_USER } from "./middleware/local-auth.js";
import { createGoogleAuth } from "./middleware/google-auth.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { hostGuard, cors, localOnly } from "./middleware/local-only.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { requestLogger } from "./middleware/request-logger.js";
import { notFoundHandler, errorHandler } from "./middleware/error-handler.js";
import { createApiRouter } from "./routes/index.js";
import { fontRoutes } from "./routes/fonts.js";
import { uiStaticRoutes } from "./routes/ui-static.js";
import { createTracker } from "./dev/tracker.js";
import { devRoutes } from "./dev/dev-router.js";

/** Reported by GET /api/v1/health; keep in step with package.json. */
const VERSION = "0.1.0";

/**
 * Builds the Express app with every service wired in.
 *
 * @param {object} config  the result of loadConfig() (config/load-config.js)
 * @param {object} [deps]  optional replacements, used by the tests and for a custom sign-in:
 * @param {import("node:sqlite").DatabaseSync} [deps.db]  an already opened database (default: open config.dbFile)
 * @param {Function} [deps.authenticate]  Express middleware that sets req.user (default: AUTH_MODE decides)
 * @param {typeof fetch} [deps.fetchImpl]   fetch used to call the Python worker
 * @param {typeof fetch} [deps.googleFetch] fetch used to call Google during sign-in
 * @param {() => number} [deps.clock]       current time in ms (default Date.now)
 * @returns {import("express").Express} the app; app.locals holds { db, repo, tracker }
 * @throws {Error} when PY_NOTES_URL is invalid or the Google sign-in settings are incomplete
 */
export function createApp(config, deps = {}) {
  // -------------------------------------------------------------------------
  // 1. Building blocks: database, worker client, services
  // -------------------------------------------------------------------------

  assertPyUrl(config.pyUrl, config.allowRemotePy);
  const db = deps.db || openDb(config.dbFile, config.sqlDir);
  const repo = createRepo(db);
  const clock = deps.clock || Date.now;

  const tracker = config.devTools ? createTracker({ logDir: config.devLogDir, keepDays: config.devLogDays }) : null;
  const fetchImpl = deps.fetchImpl || fetch;
  // With the tracker on, every call to the worker is recorded (layer "worker").
  const py = createPyClient({
    baseUrl: config.pyUrl,
    timeoutMs: config.notes.pyTimeoutMs,
    fetchImpl: tracker ? tracker.wrapFetch(fetchImpl) : fetchImpl
  });

  const onChange = tracker ? tracker.change : null;
  const ai = createAiKeysService({ db, py, config, clock });
  const notes = createNotesService({ db, repo, py, ai, config, clock, onChange });
  const smart = createSmartService({ db, repo, py, ai, config, clock, onChange });
  const assistant = createAssistantService({ db, repo, py, ai });
  // AUTH_MODE=google: Google sign-in with server-side sessions; otherwise the single local user.
  const google =
    config.authMode === "google" && !deps.authenticate
      ? createGoogleAuth(config.google, { repo, fetchImpl: deps.googleFetch || fetch, clock })
      : null;
  const authenticate = deps.authenticate || (google ? google.authenticate : localAuth);

  // -------------------------------------------------------------------------
  // 2. The Express app and global middleware
  // -------------------------------------------------------------------------

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.locals.db = db;
  app.locals.repo = repo;
  app.locals.tracker = tracker;

  app.use(securityHeaders);
  if (config.log) app.use(requestLogger);
  app.use(hostGuard);
  app.use(cors);

  // -------------------------------------------------------------------------
  // 3. Developer tools (/dev)
  // -------------------------------------------------------------------------

  if (tracker) {
    app.use(tracker.middleware);
    // A separate, unrecorded client: the overview page probes the worker every few seconds,
    // and those probes would otherwise flood the request log they are shown next to.
    const quietPy = createPyClient({ baseUrl: config.pyUrl, timeoutMs: 1500, fetchImpl });
    app.use("/dev", localOnly, devRoutes({ db, py: quietPy, tracker, runDir: config.runDir }));
  }

  // -------------------------------------------------------------------------
  // 4. The API (/api/v1)
  // -------------------------------------------------------------------------

  const generalLimiter = rateLimit({ ...config.rate.general, trustCf: config.trustCfHeaders }, deps.clock);
  const heavyLimiter = rateLimit({ ...config.rate.heavy, trustCf: config.trustCfHeaders }, deps.clock);

  app.use(
    "/api/v1",
    createApiRouter({
      db,
      repo,
      py,
      notes,
      smart,
      ai,
      assistant,
      config,
      authenticate,
      google,
      localUserId: LOCAL_USER.id,
      generalLimiter,
      heavyLimiter,
      version: VERSION
    })
  );
  app.use("/api", notFoundHandler); // e.g. /api/v2/... or /api/anything

  // -------------------------------------------------------------------------
  // 5. Fonts for the notes page, then the UI (same origin as the API)
  // -------------------------------------------------------------------------

  app.use(fontRoutes(py));
  if (config.uiDir && fs.existsSync(config.uiDir)) app.use(uiStaticRoutes(config.uiDir));

  // -------------------------------------------------------------------------
  // 6. Nothing matched / something failed: always JSON, never a stack trace
  // -------------------------------------------------------------------------

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

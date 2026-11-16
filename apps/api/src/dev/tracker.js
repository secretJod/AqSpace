/* tracker.js - the developer tracker: records requests and job state changes.

   What:  keeps two ring buffers (requests, events) and, if enabled, writes them to disk.
          Three ways things get recorded:
            - middleware:  every HTTP request to this server (layer "api", "ui" or "dev");
            - wrapFetch:   every call this server makes to the Python worker (layer "worker");
            - change():    notes / smart job state changes (passed to the services as onChange).
   Privacy: never stores query strings, headers, cookies or bodies; ids in paths are masked.
   How it fits: created in app.js when config.devTools is on (AQ_DEV_TOOLS != "0").
   Read next: dev/dev-router.js */
import { maskPath } from "./mask-path.js";
import { createRingBuffer } from "./ring-buffer.js";
import { createDevLog } from "./dev-log-store.js";

// DB status -> the state name the UI uses.
const PUBLIC_STATE = { done: "ready", expired: "none" };
const publicState = (status) => (status == null ? null : PUBLIC_STATE[status] || status);

export function createTracker({ max = 2000, logDir = "", keepDays = 14, flushMs } = {}) {
  // -------------------------------------------------------------------------
  // 1. Storage: optional disk log + two ring buffers
  // -------------------------------------------------------------------------

  let log = null;
  if (logDir) {
    try {
      log = createDevLog({ dir: logDir, keepDays, flushMs });
    } catch (e) {
      console.error(`dev log disabled: ${e.code || e.message}`);
    }
  }
  // Tracker polling (layer "dev") is kept in memory but not written to disk.
  const requests = createRingBuffer(
    max,
    log &&
      ((entry) => {
        if (entry.layer !== "dev") log.append("requests", entry);
      })
  );
  const events = createRingBuffer(max, log && ((entry) => log.append("events", entry)));

  // -------------------------------------------------------------------------
  // 2. Job state changes
  // -------------------------------------------------------------------------

  /** {kind, jobId, videoId, playlistId, before, after}: pushed only when status/stage/pct changed. */
  function change(kind, ids, before, after) {
    if (!after) return;
    const nothingChanged =
      before && before.status === after.status && before.stage === after.stage && before.pct === after.pct;
    if (nothingChanged) return;
    events.push({
      kind,
      jobId: after.job_id || null,
      videoId: ids.videoId ?? null,
      playlistId: ids.playlistId ?? null,
      from: before ? publicState(before.status) : null,
      to: publicState(after.status),
      stage: after.stage,
      pct: after.pct
    });
  }

  // -------------------------------------------------------------------------
  // 3. Calls to the Python worker
  // -------------------------------------------------------------------------

  /** fetch wrapper for the worker client: records layer "worker" (status 0 = network error). */
  function wrapFetch(fetchImpl) {
    return async (url, opts = {}) => {
      const startedAt = Date.now();
      const method = opts.method || "GET";
      let pathname = "/";
      try {
        pathname = new URL(url).pathname;
      } catch {
        /* keep "/" */
      }
      const record = (status) =>
        requests.push({ method, path: maskPath(pathname), status, ms: Date.now() - startedAt, layer: "worker" });
      try {
        const res = await fetchImpl(url, opts);
        record(res.status);
        return res;
      } catch (e) {
        record(0);
        throw e;
      }
    };
  }

  // -------------------------------------------------------------------------
  // 4. Requests to this server
  // -------------------------------------------------------------------------

  function middleware(req, res, next) {
    const startedAt = Date.now();
    res.on("finish", () => {
      const p = req.originalUrl.split("?")[0];
      const layer = p.startsWith("/dev") ? "dev" : p.startsWith("/api/") ? "api" : "ui";
      requests.push({
        method: req.method,
        path: maskPath(p),
        status: res.statusCode,
        ms: Date.now() - startedAt,
        layer
      });
    });
    next();
  }

  return {
    requests,
    events,
    log,
    keepDays,
    request: (fields) => requests.push(fields),
    change,
    wrapFetch,
    middleware
  };
}

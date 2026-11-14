/* local-only.js - keeps the API reachable only from this machine's own pages.

   What:  hostGuard refuses requests whose Host header is not localhost (DNS-rebinding guard).
          cors answers CORS only for local origins and refuses state-changing requests from others.
   How it fits: run in app.js right after the request logger.
   Read next: middleware/rate-limit.js */
import { HttpError } from "../utils/http-errors.js";

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

// ---------------------------------------------------------------------------
// 1. Host guard
// ---------------------------------------------------------------------------

/** Only answer to local host names (DNS-rebinding guard). */
export function hostGuard(req, res, next) {
  if (!LOCAL_HOST_RE.test(req.headers.host || "")) return next(new HttpError(403, "Forbidden host."));
  next();
}

// ---------------------------------------------------------------------------
// 2. CORS
// ---------------------------------------------------------------------------

const isReadOnly = (method) => method === "GET" || method === "HEAD";

/** CORS for local pages only. A non-local Origin on a state-changing request is refused outright. */
export function cors(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next();                        // same-origin or non-browser request

  const isLocal = LOCAL_ORIGIN_RE.test(origin);
  if (!isLocal && !isReadOnly(req.method)) return next(new HttpError(403, "Forbidden origin."));

  if (isLocal) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.append("Vary", "Origin");
    if (req.method === "OPTIONS") {                  // preflight
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
      return res.status(204).end();
    }
  } else if (req.method === "OPTIONS") {
    return res.status(204).end();                    // no CORS headers: the browser blocks the real request
  }
  next();
}

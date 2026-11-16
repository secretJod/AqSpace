/* error-handler.js - the "not found" fallback and the final error handler.

   What:  notFoundHandler turns "no route matched" into a 404 error.
          errorHandler turns any error into a JSON reply {error, code?} - never a stack trace.
   How it fits: registered last in app.js. Routes and services just `throw` (Express 5
          forwards errors from async handlers here automatically).
   Read next: routes/index.js */
import { HttpError } from "../utils/http-errors.js";

// ---------------------------------------------------------------------------
// 1. 404
// ---------------------------------------------------------------------------

/** Middleware: anything that reaches it becomes a 404 HttpError for errorHandler. */
export function notFoundHandler(_req, _res, next) {
  next(new HttpError(404, "Not found."));
}

// ---------------------------------------------------------------------------
// 2. Errors -> JSON
// ---------------------------------------------------------------------------

// Error codes the UI understands; only these are sent back as `code`, so internal codes (SQLite, Node) never leak.
const PUBLIC_CODES = new Set(["py_offline", "not_in_playlist", "auth_required"]);

/**
 * Express error handler: turns any error into {error, code?} with a sensible status.
 * Only HttpErrors (expose = true) show their message; everything else is "Something went wrong."
 * The four arguments are required: that is how Express recognises an error handler.
 */
export function errorHandler(err, req, res, _next) {
  if (res.headersSent) return res.destroy(); // a stream broke half way: nothing sensible to send

  const { status, message } = describeError(err, req);
  if (err.retryAfter) res.setHeader("Retry-After", String(err.retryAfter));
  res.status(status).json({ error: message, ...(PUBLIC_CODES.has(err.code) ? { code: err.code } : {}) });
}

/** Picks the status and the user-facing message. Unexpected 5xx errors are logged (short, no stack). */
function describeError(err, req) {
  let status = err.status || err.statusCode || 500;
  let message = err.expose ? err.message : "Something went wrong.";

  if (err.type === "entity.parse.failed") {
    // express.json() could not parse the body
    status = 400;
    message = "The request body is not valid JSON.";
  } else if (err.type === "entity.too.large") {
    // body bigger than the limit
    status = 413;
    message = "The request body is too large.";
  } else if (/SQLITE_CONSTRAINT/.test(String(err.code || err.message))) {
    status = 409;
    message = "That conflicts with existing data.";
  } else if (status >= 500 && !err.expose) {
    console.error(`${req.method} ${req.path} failed: ${err.name}: ${String(err.message).slice(0, 200)}`);
  }

  if (status < 400 || status > 599) status = 500;
  return { status, message };
}

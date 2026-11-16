/* worker-client.js - a thin client for the Python worker (notes + AI, http://127.0.0.1:5055).

   What:  json() for API calls that answer JSON, raw() for files we stream to the browser.
          When the worker cannot be reached, both throw a 503 HttpError with code "py_offline".
   How it fits: created in app.js and passed to the notes / smart services and some routes.
   Safety: only fixed, validated paths are ever requested, redirects are refused, and
          assertPyUrl() refuses a non-local worker address unless ALLOW_REMOTE_PY=1.
   Read next: services/notes-service.js */
import { HttpError } from "../utils/http-errors.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

// ---------------------------------------------------------------------------
// 1. Checking the worker address (runs once at start-up)
// ---------------------------------------------------------------------------

export function assertPyUrl(url, allowRemote = false) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`PY_NOTES_URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("PY_NOTES_URL must be http(s).");
  if (!allowRemote && !LOOPBACK_HOSTS.has(parsed.hostname))
    throw new Error("PY_NOTES_URL must point to this machine (set ALLOW_REMOTE_PY=1 to override).");
}

// ---------------------------------------------------------------------------
// 2. The client
// ---------------------------------------------------------------------------

/** fetchImpl can be swapped (tests, or the dev tracker which records each call). */
export function createPyClient({ baseUrl, timeoutMs = 10_000, fetchImpl = fetch }) {
  /** -> {status, headers, json} (json = null when the body is not JSON). Throws HttpError 503 when the service is unreachable. */
  async function json(path, { method = "GET", body, timeout = timeoutMs } = {}) {
    let res;
    try {
      res = await fetchImpl(baseUrl + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw offlineError(e);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, json: data };
  }

  /** Raw response (body not consumed) for streaming files through. */
  async function raw(path, { method = "GET", timeout = 30_000 } = {}) {
    try {
      return await fetchImpl(baseUrl + path, { method, redirect: "error", signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw offlineError(e);
    }
  }

  return { json, raw };
}

// ---------------------------------------------------------------------------
// 3. Errors
// ---------------------------------------------------------------------------

/** A network failure or timeout becomes a friendly 503 the UI understands (code "py_offline"). */
function offlineError(e) {
  const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
  const message = timedOut
    ? "The notes service took too long to answer."
    : "The notes service is not running. Start it (docker compose up) and try again.";
  return new HttpError(503, message, { code: "py_offline" });
}

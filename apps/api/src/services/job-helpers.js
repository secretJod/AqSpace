/* job-helpers.js - small tools shared by the notes and smart services.

   What:  a per-key lock (so two clicks never start two jobs), safe short text,
          the current time as ISO text, and turning a worker "start job" error into an HttpError.
   How it fits: imported by services/notes-service.js and services/smart-service.js.
   Read next: services/notes-service.js */
import { HttpError } from "../utils/http-errors.js";

// ---------------------------------------------------------------------------
// 1. Text and time
// ---------------------------------------------------------------------------

export const nowIso = () => new Date().toISOString();

/** Any value -> a single-line string of at most n characters (worker messages go into the UI). */
export const short = (s, n = 300) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f]/g, " ")
    .slice(0, n);

// ---------------------------------------------------------------------------
// 2. Per-key lock
// ---------------------------------------------------------------------------

/** Returns withLock(key, fn): calls with the same key run one after another, never at the same time.
    Each key keeps a promise chain; it is removed again when the chain is empty. */
export function createKeyedLock() {
  const chains = new Map();
  return function withLock(key, fn) {
    const previous = chains.get(key) || Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => {}); // the next caller waits for us, but never sees our error
    chains.set(key, tail);
    tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  };
}

// ---------------------------------------------------------------------------
// 3. Worker progress -> database fields
// ---------------------------------------------------------------------------

/** Fields to store for a job the worker reports as still queued/running.
    The percentage never goes backwards and stays within 0..100. */
export function inProgressFields(row, workerJob, clock) {
  const pct = Number(workerJob.pct);
  return {
    status: workerJob.status === "running" ? "running" : "queued",
    pct: Number.isFinite(pct) ? Math.max(row.pct, Math.min(100, Math.round(pct))) : row.pct,
    stage: short(workerJob.stage, 20),
    message: short(workerJob.message, 160),
    checked_at: clock()
  };
}

// ---------------------------------------------------------------------------
// 4. Worker answers to "start a job"
// ---------------------------------------------------------------------------

/** A 4xx (not 404) from the worker means "your input was refused" -> 422; anything else -> 502. */
export function startFailedError(response, fallbackMessage) {
  const message = short(response.json && response.json.error) || fallbackMessage;
  const clientProblem = response.status >= 400 && response.status < 500 && response.status !== 404;
  return new HttpError(clientProblem ? 422 : 502, message);
}

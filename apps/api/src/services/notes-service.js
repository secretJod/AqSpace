/* notes-service.js - lecture notes for a video: start them, follow progress, serve the files.

   What:  the Python worker generates the notes; this service remembers each job per video
          in the `notes_jobs` table so finished notes are reused (a cache shared by all users).
   How it fits: routes/notes.js calls status() / list() / start() / file().
   Rules:
     - one live job (queued / running / done) per video across all users
       (a partial unique index in the DB + an in-process lock);
     - start(): a ready video returns immediately (cached); a running one returns its progress;
       otherwise a new job is started in the worker;
     - jobs on the local model can run for hours (24h videos): nothing here expires or times out a
       queued/running record by age. pyTimeoutMs is only the per-request HTTP timeout;
     - worker job ids are lost when the worker restarts. For a queued/running record a 404 re-submits
       the same video (the worker resumes from its per-video chunk checkpoints) up to maxAutoResumes
       times, then the record becomes an error. A 404 for a ready record (files gone) still marks it
       "expired" (a new job may then be started);
     - progress messages carry "(chunk i/N)" when the worker reports chunk counters.
   States: DB status queued/running/done/error/expired -> UI state queued/running/ready/error/none.
   Read next: services/smart-service.js */
import { HttpError } from "../utils/http-errors.js";
import { JOB_ID_RE } from "../utils/validate.js";
import { nowIso } from "../utils/time.js";
import { short, createKeyedLock, inProgressFields, startFailedError } from "./job-helpers.js";

const PUBLIC_STATE = { queued: "queued", running: "running", done: "ready", error: "error", expired: "none" };
const EXPIRED_MESSAGE = "Notes expired - generate again";

/**
 * Builds the notes service.
 *
 * @param {object} deps
 * @param {import("node:sqlite").DatabaseSync} deps.db
 * @param {object} deps.repo     the repository
 * @param {object} deps.py       the worker client (services/worker-client.js)
 * @param {object} deps.config   uses config.notes timings, config.pyProvider and config.requireMembership
 * @param {() => number} [deps.clock]  current time in ms
 * @param {Function | null} [deps.onChange]  onChange(kind, ids, before, after) after every row change
 *        (the dev tracker records these as job events)
 * @returns {{ status: Function, list: Function, start: Function, file: Function }}
 */
export function createNotesService({ db, repo, py, config, clock = Date.now, onChange = null }) {
  const timings = config.notes;
  const withLock = createKeyedLock(); // key: videoId

  // -------------------------------------------------------------------------
  // 1. Reading and writing notes_jobs rows
  // -------------------------------------------------------------------------

  const findLiveRow = (videoId) =>
    db.prepare("SELECT * FROM notes_jobs WHERE video_id = ? AND status IN ('queued','running','done')").get(videoId) ||
    null;
  const findLastRow = (videoId) =>
    db.prepare("SELECT * FROM notes_jobs WHERE video_id = ? ORDER BY id DESC LIMIT 1").get(videoId) || null;
  const findRowById = (id) => db.prepare("SELECT * FROM notes_jobs WHERE id = ?").get(id);

  /** Updates the given columns (and updated_at) of one row, then tells onChange. */
  function updateRow(id, fields) {
    const columns = Object.keys(fields);
    const before = onChange && findRowById(id);
    db.prepare(`UPDATE notes_jobs SET ${columns.map((c) => c + " = ?").join(", ")}, updated_at = ? WHERE id = ?`).run(
      ...columns.map((c) => fields[c]),
      nowIso(),
      id
    );
    if (onChange) {
      const after = findRowById(id);
      onChange("notes", { videoId: after.video_id }, before, after);
    }
  }

  const markExpired = (row) => updateRow(row.id, { status: "expired", message: EXPIRED_MESSAGE, checked_at: clock() });

  /** Row -> what the UI sees. No row -> state "none". */
  function toPublic(videoId, row, extra = {}) {
    if (!row) return { videoId, state: "none", pct: 0, stage: "", message: "", error: "", jobId: null, ...extra };
    const state = PUBLIC_STATE[row.status];
    return {
      videoId,
      state,
      pct: state === "ready" ? 100 : row.pct,
      stage: row.stage,
      message: row.message,
      error: row.error,
      jobId: row.status === "expired" ? null : row.job_id,
      resumes: row.resumes || 0,
      ...extra
    };
  }

  // -------------------------------------------------------------------------
  // 2. Asking the worker
  // -------------------------------------------------------------------------

  const maxResumes = () => (Number.isInteger(timings.maxAutoResumes) ? timings.maxAutoResumes : 3);
  const jobBody = (videoId) => ({ url: "https://www.youtube.com/watch?v=" + videoId, provider: config.pyProvider });

  /** The worker lost a queued/running job (restart): submit the same video again so it resumes from its checkpoints. */
  function resume(row) {
    return withLock(row.video_id, async () => {
      const cur = findRowById(row.id);
      if (cur.job_id !== row.job_id || (cur.status !== "queued" && cur.status !== "running")) return cur; // already handled
      if (cur.resumes >= maxResumes()) {
        const msg = `The notes service restarted ${cur.resumes + 1} times during this job. Generate the notes again.`;
        updateRow(cur.id, {
          status: "error",
          error: msg,
          message: "Stopped after repeated restarts",
          checked_at: clock()
        });
        return findRowById(cur.id);
      }
      let answer;
      try {
        answer = await py.json("/api/jobs", {
          method: "POST",
          timeout: timings.pyTimeoutMs,
          body: jobBody(cur.video_id)
        });
      } catch {
        return cur;
      } // worker down again: try on the next poll
      if (answer.status === 202 && answer.json && JOB_ID_RE.test(String(answer.json.job_id || ""))) {
        updateRow(cur.id, {
          job_id: answer.json.job_id,
          status: "queued",
          resumes: cur.resumes + 1,
          stage: "resume",
          message: "Resuming after restart",
          checked_at: clock()
        });
      } else if (answer.status === 429 || answer.status >= 500) {
        updateRow(cur.id, { message: "Waiting to resume after restart", checked_at: clock() }); // busy / failing: retry on a later poll
      } else {
        const msg =
          short(answer.json && answer.json.error) || `The notes service refused to resume (status ${answer.status}).`;
        updateRow(cur.id, { status: "error", error: msg, message: short(msg, 160), checked_at: clock() });
      }
      return findRowById(cur.id);
    });
  }

  /** "message (chunk i/N)" when the worker reports chunk counters that its message does not already show. */
  function progressMessage(job) {
    const msg = short(job.message, 160);
    const i = Number(job.chunk),
      n = Number(job.chunks);
    if (
      job.chunk == null ||
      job.chunks == null ||
      !Number.isInteger(i) ||
      !Number.isInteger(n) ||
      n <= 0 ||
      i < 0 ||
      i > n ||
      /\d+\s*\/\s*\d+/.test(msg)
    )
      return msg;
    const tag = `chunk ${i}/${n}`;
    return msg ? `${msg.slice(0, 160 - tag.length - 3)} (${tag})` : tag;
  }

  /** Ask the worker how a queued/running job is doing (throttled). Network trouble keeps the record as it is. */
  async function refresh(row) {
    if (clock() - row.checked_at < timings.pollMinMs) return row;
    let answer;
    try {
      answer = await py.json(`/api/jobs/${row.job_id}`);
    } catch {
      return row;
    }
    if (answer.status === 404) return resume(row);
    if (answer.status !== 200 || !answer.json) return row;

    const job = answer.json;
    if (job.status === "done") {
      updateRow(row.id, {
        status: "done",
        pct: 100,
        stage: "pdf",
        message: "Notes ready",
        error: "",
        checked_at: clock()
      });
    } else if (job.status === "error") {
      updateRow(row.id, {
        status: "error",
        error: short(job.error || "The notes engine reported an error."),
        message: short(job.error || "Error"),
        checked_at: clock()
      });
    } else {
      updateRow(row.id, { ...inProgressFields(row, job, clock), message: progressMessage(job) });
    }
    return findRowById(row.id);
  }

  /** A ready record: make sure the worker still has the files (definitive 404 -> expired). Checked at most every verifyMs. */
  async function verify(row) {
    if (clock() - row.checked_at < timings.verifyMs) return row;
    try {
      const res = await py.raw(`/api/jobs/${row.job_id}/notes.html`, { method: "HEAD", timeout: timings.pyTimeoutMs });
      await res.body?.cancel();
      if (res.status === 404) markExpired(row);
      else updateRow(row.id, { checked_at: clock() });
      return findRowById(row.id);
    } catch {
      return row;
    }
  }

  /** The live row for a video, brought up to date (or null). */
  async function currentRow(videoId) {
    const row = findLiveRow(videoId);
    if (!row) return null;
    return row.status === "done" ? verify(row) : refresh(row);
  }

  // -------------------------------------------------------------------------
  // 3. Public functions (used by routes/notes.js)
  // -------------------------------------------------------------------------

  /** Status for the UI: {state: none|queued|running|ready|error, pct, stage, message, error, jobId}. */
  async function status(videoId) {
    const row = await currentRow(videoId);
    if (row) return toPublic(videoId, row);
    // Nothing live: show the last error/expiry so the UI can explain it.
    const last = findLastRow(videoId);
    return toPublic(videoId, last && (last.status === "error" || last.status === "expired") ? last : null);
  }

  /** Every record that is queued / running / ready (database only, no calls to the worker). */
  function list() {
    return db
      .prepare("SELECT * FROM notes_jobs WHERE status IN ('queued','running','done') ORDER BY id")
      .all()
      .map((row) => toPublic(row.video_id, row));
  }

  /** Start notes for a video. -> {started: boolean, status}. `cached` is true when nothing new was started. */
  function start(user, videoId) {
    if (config.requireMembership && !repo.userHasVideo(user.id, videoId)) {
      return Promise.reject(
        new HttpError(403, "Add this video to one of your playlists first.", { code: "not_in_playlist" })
      );
    }
    return withLock(videoId, async () => {
      const existing = await currentRow(videoId);
      if (existing && existing.status !== "expired" && existing.status !== "error") {
        return { started: false, status: toPublic(videoId, existing, { cached: true }) };
      }
      const jobId = await startWorkerJob(videoId);
      const id = insertJobRow(videoId, jobId, user.id);
      if (onChange) onChange("notes", { videoId }, null, findRowById(id));
      return { started: true, status: toPublic(videoId, findRowById(id)) };
    });
  }

  /** The finished file for a video: a Response from the worker to stream through. Throws 404 when there is none. */
  async function file(videoId, kind) {
    const row = findLiveRow(videoId);
    if (!row || row.status !== "done") throw new HttpError(404, "Notes are not ready for this video.");
    const res = await py.raw(`/api/jobs/${row.job_id}/notes.${kind}`);
    if (res.status === 404) {
      await res.body?.cancel();
      markExpired(row);
      throw new HttpError(404, "These notes expired. Generate them again.");
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new HttpError(502, "The notes service could not provide the file.");
    }
    return res;
  }

  // -------------------------------------------------------------------------
  // 4. Starting a job (helpers for start())
  // -------------------------------------------------------------------------

  /** POST /api/jobs on the worker. Returns the new job id or throws an HttpError. */
  async function startWorkerJob(videoId) {
    const answer = await py.json("/api/jobs", { method: "POST", timeout: timings.pyTimeoutMs, body: jobBody(videoId) });
    if (answer.status === 429)
      throw new HttpError(429, "The notes service is busy. Try again in a few seconds.", { retryAfter: 6 });
    if (answer.status !== 202 || !answer.json || !JOB_ID_RE.test(String(answer.json.job_id || ""))) {
      throw startFailedError(answer, `The notes service answered with status ${answer.status}.`);
    }
    return answer.json.job_id;
  }

  function insertJobRow(videoId, jobId, userId) {
    repo.ensureVideo({ id: videoId, title: "", channel: "", durationSec: 0 });
    const now = nowIso();
    return Number(
      db
        .prepare(
          "INSERT INTO notes_jobs (video_id, job_id, status, pct, message, requested_by, created_at, updated_at, checked_at) VALUES (?, ?, 'queued', 0, 'Queued...', ?, ?, ?, ?)"
        )
        .run(videoId, jobId, userId, now, now, clock()).lastInsertRowid
    );
  }

  return { status, list, start, file };
}

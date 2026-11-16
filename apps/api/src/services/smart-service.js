/* smart-service.js - "smart playlist" runs: a language model suggests an order for the videos and topics to cover.

   What:  the Python worker does the model work (POST /api/smart, GET /api/smart/<id>);
          this service remembers each run per playlist in the `smart_runs` table and
          stores the finished result there.
   How it fits: routes/smart.js calls status() and start().
   Rules:
     - fingerprint = sha256(goal + sorted video ids). A queued / running / ready run with the
       same fingerprint is returned instead of starting a new one;
     - worker job ids are lost when the worker restarts: a 404 turns a queued/running run into
       an error ("interrupted");
     - a ready run is complete in the database and never asks the worker again;
     - a failed run never blocks a new start.
   Read next: routes/index.js (how services are wired to URLs) */
import { createHash } from "node:crypto";
import { HttpError } from "../utils/http-errors.js";
import { JOB_ID_RE, isObj } from "../utils/validate.js";
import { nowIso } from "../utils/time.js";
import { short, createKeyedLock, inProgressFields, startFailedError } from "./job-helpers.js";

const PUBLIC_STATE = { queued: "queued", running: "running", done: "ready", error: "error" };
const MIN_VIDEOS = 2,
  MAX_VIDEOS = 20;
const MAX_RESULT_CHARS = 512 * 1024,
  MAX_USAGE_CHARS = 8 * 1024;
const INTERRUPTED = "The analysis was interrupted - run it again";

/** Identifies "this goal with exactly these videos" (order does not matter). */
const fingerprintOf = (goal, ids) =>
  createHash("sha256")
    .update(JSON.stringify([goal, [...ids].sort()]))
    .digest("hex");

/**
 * Builds the smart playlist service.
 *
 * @param {object} deps
 * @param {import("node:sqlite").DatabaseSync} deps.db
 * @param {object} deps.repo     the repository
 * @param {object} deps.py       the worker client (services/worker-client.js)
 * @param {object} deps.config   uses config.notes timings, config.pySmartProvider and config.pySmartModel
 * @param {() => number} [deps.clock]  current time in ms
 * @param {Function | null} [deps.onChange]  onChange(kind, ids, before, after) after every row change
 *        (the dev tracker records these as job events)
 * @returns {{ status: Function, start: Function }}
 */
export function createSmartService({ db, repo, py, config, clock = Date.now, onChange = null }) {
  const timings = config.notes;
  const withLock = createKeyedLock(); // key: playlist pk

  // -------------------------------------------------------------------------
  // 1. Reading and writing smart_runs rows
  // -------------------------------------------------------------------------

  const slugOf = (pk) => (db.prepare("SELECT slug FROM playlists WHERE pk = ?").get(pk) || {}).slug ?? null;
  const findRowById = (id) => db.prepare("SELECT * FROM smart_runs WHERE id = ?").get(id);
  const findLatestRow = (pk) =>
    db.prepare("SELECT * FROM smart_runs WHERE playlist_pk = ? ORDER BY id DESC LIMIT 1").get(pk) || null;
  const findLiveRow = (pk, fingerprint) =>
    db
      .prepare(
        "SELECT * FROM smart_runs WHERE playlist_pk = ? AND fingerprint = ? AND status IN ('queued','running','done')"
      )
      .get(pk, fingerprint) || null;

  /** The user's playlist (404 when it is not theirs) with its pk and the fingerprint of its goal + videos right now. */
  function loadPlaylist(user, slug) {
    const playlist = repo.getPlaylist(user.id, slug);
    const { pk } = db.prepare("SELECT pk FROM playlists WHERE user_id = ? AND slug = ?").get(user.id, slug);
    return {
      pk,
      playlist,
      fingerprint: fingerprintOf(
        playlist.name,
        playlist.videos.map((v) => v.id)
      )
    };
  }

  /** Updates the given columns (and updated_at) of one row, then tells onChange. */
  function updateRow(id, fields) {
    const columns = Object.keys(fields);
    const before = onChange && findRowById(id);
    db.prepare(`UPDATE smart_runs SET ${columns.map((c) => c + " = ?").join(", ")}, updated_at = ? WHERE id = ?`).run(
      ...columns.map((c) => fields[c]),
      nowIso(),
      id
    );
    if (onChange) {
      const after = findRowById(id);
      onChange("smart", { playlistId: slugOf(after.playlist_pk) }, before, after);
    }
  }

  const markFailed = (row, message) =>
    updateRow(row.id, { status: "error", error: short(message), message: short(message, 160), checked_at: clock() });

  /** Public state: {state, pct, stage, message, error, fingerprint, current, generatedAt, provider, model, result?, usage?}. */
  function toPublic(row, currentFingerprint, extra = {}) {
    if (!row) {
      return {
        state: "none",
        pct: 0,
        stage: "",
        message: "",
        error: "",
        fingerprint: "",
        current: false,
        generatedAt: null,
        provider: "",
        model: "",
        ...extra
      };
    }
    const state = PUBLIC_STATE[row.status];
    const out = {
      state,
      pct: state === "ready" ? 100 : row.pct,
      stage: row.stage,
      message: row.message,
      error: row.error,
      fingerprint: row.fingerprint,
      current: row.fingerprint === currentFingerprint, // false = the playlist changed since
      generatedAt: state === "ready" ? row.updated_at : row.created_at,
      provider: row.provider,
      model: row.model,
      ...extra
    };
    if (state === "ready") {
      try {
        out.result = JSON.parse(row.result_json);
        out.usage = JSON.parse(row.usage_json || "{}");
      } catch {
        return { ...out, state: "error", error: "The stored result is unreadable - run it again." };
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 2. Asking the worker
  // -------------------------------------------------------------------------

  /** Ask the worker how a queued/running run is doing (throttled). Network trouble keeps the record as it is. */
  async function refresh(row) {
    if (row.status !== "queued" && row.status !== "running") return row;
    if (clock() - row.checked_at < timings.pollMinMs) return row;
    let answer;
    try {
      answer = await py.json(`/api/smart/${row.job_id}`);
    } catch {
      return row;
    }
    if (answer.status === 404) {
      markFailed(row, INTERRUPTED);
      return findRowById(row.id);
    }
    if (answer.status !== 200 || !answer.json) return row;

    const job = answer.json;
    if (job.status === "done") saveFinishedResult(row, job);
    else if (job.status === "error") markFailed(row, job.error || "The analysis engine reported an error.");
    else updateRow(row.id, inProgressFields(row, job, clock));
    return findRowById(row.id);
  }

  /** Stores the model result, unless it is missing or too big. */
  function saveFinishedResult(row, job) {
    const result = JSON.stringify(job.result ?? null);
    const usage = JSON.stringify(isObj(job.usage) ? job.usage : {});
    if (!isObj(job.result)) {
      markFailed(row, "The analysis finished without a result.");
    } else if (result.length > MAX_RESULT_CHARS || usage.length > MAX_USAGE_CHARS) {
      markFailed(row, "The analysis result is too large to store.");
    } else {
      updateRow(row.id, {
        status: "done",
        pct: 100,
        stage: "",
        message: "Ready",
        error: "",
        result_json: result,
        usage_json: usage,
        model: short(job.model || row.model, 80),
        checked_at: clock()
      });
    }
  }

  // -------------------------------------------------------------------------
  // 3. Public functions (used by routes/smart.js)
  // -------------------------------------------------------------------------

  /** The latest run of the user's playlist (refreshed from the worker while it is queued/running). */
  async function status(user, slug) {
    const { pk, fingerprint } = loadPlaylist(user, slug);
    const row = findLatestRow(pk);
    return toPublic(row && (await refresh(row)), fingerprint);
  }

  /** Start a run for the playlist. -> {started: boolean, status}. `cached` is true when an identical run already exists. */
  function start(user, slug) {
    const { pk, playlist, fingerprint } = loadPlaylist(user, slug);
    const videos = playlist.videos;
    if (videos.length < MIN_VIDEOS || videos.length > MAX_VIDEOS) {
      throw new HttpError(
        422,
        `Smart arrange needs ${MIN_VIDEOS} to ${MAX_VIDEOS} videos in the playlist (this one has ${videos.length}).`
      );
    }
    return withLock(pk, async () => {
      const existing = findLiveRow(pk, fingerprint);
      if (existing) {
        const row = await refresh(existing);
        if (row.status !== "error") return { started: false, status: toPublic(row, fingerprint, { cached: true }) };
      }
      const jobId = await startWorkerJob(playlist);
      const id = insertRunRow(pk, fingerprint, jobId, user.id);
      if (onChange) onChange("smart", { playlistId: slug }, null, findRowById(id));
      return { started: true, status: toPublic(findRowById(id), fingerprint) };
    });
  }

  // -------------------------------------------------------------------------
  // 4. Starting a run (helpers for start())
  // -------------------------------------------------------------------------

  /** POST /api/smart on the worker. Returns the new job id or throws an HttpError. */
  async function startWorkerJob(playlist) {
    const body = {
      goal: playlist.name,
      videos: playlist.videos.map((v) => ({
        id: v.id,
        title: v.title,
        channel: v.channel,
        duration_sec: v.durationSec
      })),
      provider: config.pySmartProvider
    };
    if (config.pySmartModel) body.model = config.pySmartModel;

    const answer = await py.json("/api/smart", { method: "POST", timeout: timings.pyTimeoutMs, body });
    if (answer.status === 429)
      throw new HttpError(429, "The analysis service is busy. Try again in a few seconds.", { retryAfter: 6 });
    if (answer.status !== 202 || !answer.json || !JOB_ID_RE.test(String(answer.json.job_id || ""))) {
      throw startFailedError(answer, `The analysis service answered with status ${answer.status}.`);
    }
    return answer.json.job_id;
  }

  function insertRunRow(pk, fingerprint, jobId, userId) {
    const now = nowIso();
    return Number(
      db
        .prepare(
          "INSERT INTO smart_runs (playlist_pk, fingerprint, job_id, status, pct, message, provider, model, requested_by, created_at, updated_at, checked_at) VALUES (?, ?, ?, 'queued', 0, 'Queued...', ?, ?, ?, ?, ?, ?)"
        )
        .run(pk, fingerprint, jobId, config.pySmartProvider, short(config.pySmartModel, 80), userId, now, now, clock())
        .lastInsertRowid
    );
  }

  return { status, start };
}

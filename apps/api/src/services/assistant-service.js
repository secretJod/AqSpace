/* assistant-service.js - answers a signed-in user's question from that user's own finished notes.

   What:  ask(user, {question, playlistId?}) collects the user's ready notes jobs (newest first, at most
          MAX_JOBS, optionally only the videos of one of the user's playlists), resolves the user's key for
          task "assistant", and asks the worker (POST /api/ask). The worker reads the notes and answers with
          citations; this service turns them into in-app links.
   Ownership: notes jobs are selected by user_id, so another user's notes are never sent to the model.
          Citations are only kept for videos that were sent, so the worker cannot point at anything else.
   Privacy: the question and the key are never logged; the key is decrypted inside ai.resolve() just
          before the request and only travels in the request body.
   How it fits: created in app.js; routes/assistant.js calls ask().
   Read next: services/ai-keys-service.js (resolve) */
import { HttpError, bad } from "../utils/http-errors.js";
import { isObj, slug, text } from "../utils/validate.js";
import { short } from "./job-helpers.js";

/** Longest question accepted, in characters (after trimming). */
export const MAX_QUESTION = 500;
/** Most notes sent with one question: keeps the worker's prompt and the provider's token use bounded. */
export const MAX_JOBS = 50;
/** A model answer over many notes can take a while; this is far longer than the usual worker timeout. */
const ASK_TIMEOUT_MS = 90_000;
const MAX_ANSWER_CHARS = 20_000;
const MAX_CITATIONS = 20;
const NO_NOTES_ANSWER = "You don't have any finished notes yet. Make notes for a lecture first, then ask again.";
const ERROR_KINDS = ["invalid", "quota", "network", "other"];

/**
 * In-app link to a video's notes at a moment: the split view route plus `?t=<seconds>`.
 *
 * @param {string|null} playlistSlug  a playlist of the user that holds the video (null = none)
 * @param {string} videoId
 * @param {number} startSec
 * @returns {string|null}
 */
export function citationUrl(playlistSlug, videoId, startSec) {
  if (!playlistSlug) return null;
  return `#/playlist/${playlistSlug}/notes/${videoId}?t=${startSec}`;
}

/**
 * Builds the assistant service.
 *
 * @param {object} deps
 * @param {import("node:sqlite").DatabaseSync} deps.db
 * @param {object} deps.repo  the repository (getPlaylist checks the playlist belongs to the user)
 * @param {object} deps.py    the worker client (services/worker-client.js)
 * @param {object} deps.ai    the AI keys service: resolve(user, "assistant")
 * @returns {{ ask: Function }}
 */
export function createAssistantService({ db, repo, py, ai }) {
  // Title and link playlist come from the user's own playlists: the per-playlist title wins over the
  // shared videos row, and the most recently updated playlist is used for the link.
  const JOBS_SQL = `
    SELECT j.job_id, j.video_id,
           COALESCE(
             (SELECT NULLIF(pv.title, '') FROM playlist_videos pv JOIN playlists p ON p.pk = pv.playlist_pk
               WHERE p.user_id = j.user_id AND pv.video_id = j.video_id ORDER BY p.updated_at DESC LIMIT 1),
             v.title, '') AS title,
           (SELECT p.slug FROM playlist_videos pv JOIN playlists p ON p.pk = pv.playlist_pk
             WHERE p.user_id = j.user_id AND pv.video_id = j.video_id ORDER BY p.updated_at DESC LIMIT 1) AS slug
      FROM notes_jobs j JOIN videos v ON v.id = j.video_id
     WHERE j.user_id = ? AND j.status = 'done' AND j.job_id IS NOT NULL`;

  /** The user's ready notes, newest first. With a playlist: only its videos, linked to that playlist. */
  function readyJobs(userId, playlistSlug) {
    if (!playlistSlug) {
      return db.prepare(`${JOBS_SQL} ORDER BY j.id DESC LIMIT ?`).all(userId, MAX_JOBS);
    }
    repo.getPlaylist(userId, playlistSlug); // 404 when the playlist is not the user's
    return db
      .prepare(
        `${JOBS_SQL} AND j.video_id IN (SELECT pv.video_id FROM playlist_videos pv JOIN playlists p ON p.pk = pv.playlist_pk
                                         WHERE p.user_id = ? AND p.slug = ?)
         ORDER BY j.id DESC LIMIT ?`
      )
      .all(userId, userId, playlistSlug, MAX_JOBS)
      .map((r) => ({ ...r, slug: playlistSlug }));
  }

  /**
   * Answers a question from the user's own notes.
   *
   * @param {{id: number}} user  the signed-in user
   * @param {unknown} body  {question: string, playlistId?: string}
   * @returns {Promise<{answer: string, found: boolean, citations: object[], usedNotes: number, provider: string}>}
   * @throws {HttpError} 400 bad input, 404 unknown playlist, 409 ai_key_required, 422 {kind} key or quota
   *         problem, 429 worker busy, 502 py_offline or an unusable worker answer
   */
  async function ask(user, body) {
    if (!isObj(body)) throw bad("Send a JSON object with a question.");
    const question = text(body.question);
    if (!question) throw bad("Type a question first.");
    if (question.length > MAX_QUESTION) throw bad(`Keep the question under ${MAX_QUESTION} characters.`);
    const playlistSlug = body.playlistId == null || body.playlistId === "" ? null : slug(body.playlistId);

    const jobs = readyJobs(user.id, playlistSlug);
    // No notes: nothing for a model to read, so answer here and spend none of the user's quota.
    if (!jobs.length) return { answer: NO_NOTES_ANSWER, found: false, citations: [], usedNotes: 0, provider: "" };

    const { provider, apiKey } = await ai.resolve(user, "assistant"); // may throw 409 ai_key_required
    const payload = {
      question,
      provider,
      jobs: jobs.map((j) => ({ job_id: j.job_id, video_id: j.video_id, title: j.title }))
    };
    if (apiKey) payload.api_key = apiKey; // decrypted just now, only for this request

    let answer;
    try {
      answer = await py.json("/api/ask", { method: "POST", timeout: ASK_TIMEOUT_MS, body: payload });
    } catch (e) {
      // The contract for this route reports an unreachable worker as 502 (a bad gateway, not our outage).
      if (e && e.code === "py_offline") throw new HttpError(502, e.message, { code: "py_offline" });
      throw e;
    }
    return toPublic(answer, jobs, provider);
  }

  /** Maps the worker's reply (snake_case) to the public shape, or throws the matching HttpError. */
  function toPublic(answer, jobs, provider) {
    const data = isObj(answer.json) ? answer.json : {};
    if (answer.status === 429)
      throw new HttpError(429, "The AI service is busy. Try again in a few seconds.", { retryAfter: 6 });
    if (answer.status >= 400 && answer.status < 500 && typeof data.error === "string") {
      // A key or quota problem: show the provider's reason so the user can fix their key.
      const kind = ERROR_KINDS.includes(data.kind) ? data.kind : "other";
      throw new HttpError(422, short(data.error) || "The AI provider refused the request.", { details: { kind } });
    }
    if (answer.status !== 200 || typeof data.answer !== "string") {
      throw new HttpError(502, `The AI service answered with status ${answer.status}.`, { code: "py_offline" });
    }

    const byVideo = new Map(jobs.map((j) => [j.video_id, j]));
    const citations = (Array.isArray(data.citations) ? data.citations : [])
      .filter((c) => isObj(c) && byVideo.has(c.video_id)) // only videos we sent: never trust a link from the model
      .slice(0, MAX_CITATIONS)
      .map((c) => {
        const job = byVideo.get(c.video_id);
        const startSec = Number.isFinite(c.start_sec) && c.start_sec > 0 ? Math.floor(c.start_sec) : 0;
        return {
          videoId: c.video_id,
          title: job.title,
          heading: short(text(c.heading), 200),
          startSec,
          url: citationUrl(job.slug, c.video_id, startSec)
        };
      });
    return {
      answer: data.answer.slice(0, MAX_ANSWER_CHARS),
      found: data.found === true,
      citations,
      usedNotes: Number.isInteger(data.used_notes) && data.used_notes >= 0 ? data.used_notes : jobs.length,
      provider: typeof data.provider === "string" && data.provider ? short(data.provider, 40) : provider
    };
  }

  return { ask };
}

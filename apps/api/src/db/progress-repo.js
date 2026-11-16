/* progress-repo.js - how far a user has watched each video.

   What:  read one / all progress rows and save a new position.
   How it fits: part of the repository object (db/repository.js); used by routes/progress.js.
   Note:  `updated` is a client timestamp (epoch ms). An older update than the stored one
          is ignored, so two open tabs cannot move progress backwards.
   Read next: db/sync-import-repo.js */
import { tx } from "./database.js";
import { bad } from "../utils/http-errors.js";
import * as v from "../utils/validate.js";

/** Database row -> JSON for the UI. */
export const progressToJson = (row) => ({
  pos: row.pos_sec,
  dur: row.dur_sec,
  done: !!row.done,
  updated: row.updated_ms
});

export function createProgressRepo(db, helpers) {
  const { ensureVideo } = helpers;
  const findRow = (userId, vid) =>
    db.prepare("SELECT * FROM watch_progress WHERE user_id = ? AND video_id = ?").get(userId, vid);

  // -------------------------------------------------------------------------
  // 1. Reading
  // -------------------------------------------------------------------------

  function getProgress(userId, vid) {
    const row = findRow(userId, vid);
    return row ? progressToJson(row) : null;
  }

  /** { videoId: {pos, dur, done, updated}, ... } */
  function allProgress(userId) {
    const out = {};
    for (const row of db.prepare("SELECT * FROM watch_progress WHERE user_id = ?").all(userId))
      out[row.video_id] = progressToJson(row);
    return out;
  }

  // -------------------------------------------------------------------------
  // 2. Saving
  // -------------------------------------------------------------------------

  /** body: {pos, dur, done, updated?}. An older `updated` than the stored one is ignored (returns the stored row, stale:true). */
  function putProgress(userId, vid, body) {
    v.videoId(vid);
    if (!v.isObj(body)) throw bad("Send a JSON object {pos, dur, done}.");
    const pos = v.nonNeg(body.pos ?? 0, "pos"),
      dur = v.nonNeg(body.dur ?? 0, "dur");
    if (body.done !== undefined && typeof body.done !== "boolean") throw bad("done must be true or false.");

    const now = Date.now();
    let updated = now;
    if (body.updated !== undefined) {
      if (!Number.isFinite(body.updated) || body.updated < 0) throw bad("updated must be epoch milliseconds.");
      updated = Math.min(Math.floor(body.updated), now + 60_000); // a client clock may be a little ahead, not more
    }

    return tx(db, () => {
      const current = findRow(userId, vid);
      if (current && current.updated_ms > updated) return { ...progressToJson(current), stale: true };
      ensureVideo({ id: vid, title: "", channel: "", durationSec: Math.floor(dur) });
      db.prepare(
        `INSERT INTO watch_progress (user_id, video_id, pos_sec, dur_sec, done, updated_ms) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, video_id) DO UPDATE SET pos_sec = excluded.pos_sec, dur_sec = excluded.dur_sec, done = excluded.done, updated_ms = excluded.updated_ms`
      ).run(userId, vid, pos, dur, body.done ? 1 : 0, updated);
      return progressToJson(findRow(userId, vid));
    });
  }

  return { getProgress, allProgress, putProgress };
}

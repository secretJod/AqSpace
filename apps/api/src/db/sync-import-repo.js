/* sync-import-repo.js - one-time / recovery import of the browser's localStorage data.

   What:  importState() copies playlists and watch progress sent by the UI into the database.
   How it fits: part of the repository object (db/repository.js); used by routes/sync.js.
   Behaviour:
     - lenient: invalid entries are silently dropped (old browser data can be messy);
     - mode "merge" (default) adds to what is there; "replace" also deletes server playlists
       that are not in the payload and keeps the client's video order;
     - progress only overwrites a row when the incoming `updated` is newer or equal.
   Read next: services/worker-client.js */
import { tx } from "./database.js";
import { nowIso } from "./playlist-helpers.js";
import { bad } from "../utils/http-errors.js";
import * as v from "../utils/validate.js";

export function createSyncImportRepo(db, helpers, { listPlaylists, allProgress }) {
  const { ensureVideo, findPlaylistRow, isNameTaken, appendVideos } = helpers;

  // -------------------------------------------------------------------------
  // 1. Entry point
  // -------------------------------------------------------------------------

  /** body: {mode: "merge"|"replace", playlists: [...], progress: {videoId: {pos, dur, done, updated}}}.
      Returns the full resulting state. */
  function importState(userId, body) {
    if (!v.isObj(body)) throw bad("Send a JSON object {playlists, progress}.");
    const mode = body.mode === "replace" ? "replace" : "merge";
    const playlists = Array.isArray(body.playlists) ? body.playlists : [];
    if (playlists.length > 200) throw bad("At most 200 playlists per import.");
    const progress = v.isObj(body.progress) ? body.progress : {};
    if (Object.keys(progress).length > 5000) throw bad("At most 5000 progress entries per import.");

    tx(db, () => {
      const keptSlugs = new Set();
      for (const raw of playlists) {
        const slug = importOnePlaylist(userId, raw, mode);
        if (slug) keptSlugs.add(slug);
      }
      if (mode === "replace") deletePlaylistsNotIn(userId, keptSlugs);
      for (const [vid, entry] of Object.entries(progress)) importOneProgress(userId, vid, entry);
      db.prepare("UPDATE users SET bootstrapped_at = ? WHERE id = ?").run(nowIso(), userId);
    });
    return { playlists: listPlaylists(userId, { withVideos: true }), progress: allProgress(userId) };
  }

  // -------------------------------------------------------------------------
  // 2. Playlists
  // -------------------------------------------------------------------------

  /** Imports one playlist. Returns its slug, or null when the entry was dropped. */
  function importOnePlaylist(userId, raw, mode) {
    if (!v.isObj(raw) || typeof raw.id !== "string" || !v.SLUG_RE.test(raw.id)) return null;
    const name = v.text(raw.name).slice(0, v.LIMITS.name);
    if (!name) return null;
    const description = v.text(raw.description).slice(0, v.LIMITS.description);
    let source = null;
    try {
      source = v.source(raw.source);
    } catch {
      /* ignore a bad source */
    }
    const videos = cleanUniqueVideos(raw.videos);

    const now = nowIso(),
      created = v.isoOr(raw.created, now),
      updated = v.isoOr(raw.updated, now);
    const existing = findPlaylistRow(userId, raw.id);
    const uniqueName = pickUniqueName(userId, name, existing ? existing.pk : 0);

    let pk;
    if (existing) {
      pk = existing.pk;
      db.prepare(
        "UPDATE playlists SET name = ?, description = ?, source_list_id = ?, source_imported_at = ?, updated_at = ? WHERE pk = ?"
      ).run(
        uniqueName,
        description,
        source ? source.listId : null,
        source ? source.importedAt || now : null,
        updated,
        pk
      );
      if (mode === "replace") db.prepare("DELETE FROM playlist_videos WHERE playlist_pk = ?").run(pk);
    } else {
      pk = Number(
        db
          .prepare(
            "INSERT INTO playlists (user_id, slug, name, description, source_list_id, source_imported_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            userId,
            raw.id,
            uniqueName,
            description,
            source ? source.listId : null,
            source ? source.importedAt || now : null,
            created,
            updated
          ).lastInsertRowid
      );
    }

    appendVideos(pk, videos, null);
    if (mode === "replace" && videos.length) {
      // keep the client's order
      const setPosition = db.prepare("UPDATE playlist_videos SET position = ? WHERE playlist_pk = ? AND video_id = ?");
      videos.forEach((video, index) => setPosition.run(index, pk, video.id));
    }
    return raw.id;
  }

  /** Valid videos only, each id once, at most 1000. */
  function cleanUniqueVideos(list) {
    const clean = [],
      seen = new Set();
    for (const raw of (Array.isArray(list) ? list : []).slice(0, 1000)) {
      try {
        const video = v.videoInput(raw);
        if (!seen.has(video.id)) {
          seen.add(video.id);
          clean.push(video);
        }
      } catch {
        /* drop */
      }
    }
    return clean;
  }

  /** "Name" -> "Name (2)", "Name (3)" ... while another playlist already uses it. */
  function pickUniqueName(userId, name, ownPk) {
    let candidate = name;
    for (let i = 2; isNameTaken(userId, candidate, ownPk) && i < 1000; i++) {
      candidate = `${name.slice(0, v.LIMITS.name - 6)} (${i})`;
    }
    return candidate;
  }

  function deletePlaylistsNotIn(userId, keptSlugs) {
    for (const row of db.prepare("SELECT slug FROM playlists WHERE user_id = ?").all(userId)) {
      if (!keptSlugs.has(row.slug))
        db.prepare("DELETE FROM playlists WHERE user_id = ? AND slug = ?").run(userId, row.slug);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Watch progress
  // -------------------------------------------------------------------------

  function importOneProgress(userId, vid, entry) {
    if (!v.VIDEO_ID_RE.test(vid) || !v.isObj(entry)) return;
    const pos = Number(entry.pos),
      dur = Number(entry.dur),
      updated = Number(entry.updated) || Date.now();
    if (![pos, dur].every((n) => Number.isFinite(n) && n >= 0 && n <= 1e7)) return;
    ensureVideo({ id: vid, title: "", channel: "", durationSec: Math.floor(dur) });
    // The WHERE at the end keeps a newer row that is already stored.
    db.prepare(
      `INSERT INTO watch_progress (user_id, video_id, pos_sec, dur_sec, done, updated_ms) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, video_id) DO UPDATE SET pos_sec = excluded.pos_sec, dur_sec = excluded.dur_sec, done = excluded.done, updated_ms = excluded.updated_ms
       WHERE excluded.updated_ms >= watch_progress.updated_ms`
    ).run(userId, vid, pos, dur, entry.done ? 1 : 0, Math.min(Math.floor(updated), Date.now() + 60_000));
  }

  return { importState };
}

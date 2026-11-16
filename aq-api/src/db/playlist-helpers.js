/* playlist-helpers.js - small database helpers shared by the playlist and sync-import code.

   What:  find a playlist row, turn rows into the JSON shape the UI expects,
          pick a free playlist id, append videos at a position.
   How it fits: created once per database by db/repository.js and handed to
          playlists-repo.js and sync-import-repo.js.
   Read next: db/playlists-repo.js */
import { notFound } from "../utils/http-errors.js";
import * as v from "../utils/validate.js";

export const nowIso = () => new Date().toISOString();

export function createPlaylistHelpers(db) {
  // -------------------------------------------------------------------------
  // 1. Videos table (one row per YouTube video, shared by all users)
  // -------------------------------------------------------------------------

  /** Makes sure a `videos` row exists (never overwrites an existing one). */
  function ensureVideo(video) {
    db.prepare("INSERT OR IGNORE INTO videos (id, title, channel, duration_sec) VALUES (?, ?, ?, ?)")
      .run(video.id, video.title || "", video.channel || "", video.durationSec || 0);
  }

  // -------------------------------------------------------------------------
  // 2. Finding playlists
  // -------------------------------------------------------------------------

  /** The playlist row (or null). `slug` is the public playlist id. */
  function findPlaylistRow(userId, slug) {
    return db.prepare("SELECT * FROM playlists WHERE user_id = ? AND slug = ?").get(userId, slug) || null;
  }

  /** Like findPlaylistRow, but a missing playlist is a 404. */
  function requirePlaylistRow(userId, slug) {
    const row = findPlaylistRow(userId, slug);
    if (!row) throw notFound("Playlist not found.");
    return row;
  }

  /** Is the name used by another playlist of this user? (case-insensitive) */
  function isNameTaken(userId, name, exceptPk = 0) {
    return !!db.prepare("SELECT 1 FROM playlists WHERE user_id = ? AND name = ? COLLATE NOCASE AND pk <> ?").get(userId, name, exceptPk);
  }

  /** Builds a slug from `base` ("My List!" -> "my-list") and adds -2, -3 ... until it is unused. */
  function findFreeSlug(userId, base) {
    base = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "playlist";
    let candidate = base, n = 1;
    while (findPlaylistRow(userId, candidate)) { n++; candidate = `${base}-${n}`; }
    return candidate;
  }

  /** Marks the playlist as changed now. */
  const touchPlaylist = (pk) => db.prepare("UPDATE playlists SET updated_at = ? WHERE pk = ?").run(nowIso(), pk);

  // -------------------------------------------------------------------------
  // 3. Rows -> JSON for the UI
  // -------------------------------------------------------------------------

  const videoToJson = (row) => ({
    id: row.video_id, title: row.title, channel: row.channel, durationSec: row.duration_sec, duration: v.clock(row.duration_sec),
    added: row.added_at, position: row.position
  });

  function videosOfPlaylist(pk) {
    return db.prepare("SELECT * FROM playlist_videos WHERE playlist_pk = ? ORDER BY position").all(pk).map(videoToJson);
  }

  /** The playlist as JSON. With `videos` the list is included; without, only the count and total duration. */
  function playlistToJson(row, videos) {
    const out = {
      id: row.slug, name: row.name, description: row.description, created: row.created_at, updated: row.updated_at,
      videoCount: 0, durationSec: 0
    };
    if (row.source_list_id) {
      out.source = {
        type: "youtube", listId: row.source_list_id,
        url: "https://www.youtube.com/playlist?list=" + row.source_list_id, importedAt: row.source_imported_at
      };
    }
    if (videos) {
      out.videoCount = videos.length;
      out.durationSec = videos.reduce((sum, video) => sum + video.durationSec, 0);
      out.videos = videos;
    } else {
      const totals = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(duration_sec), 0) AS d FROM playlist_videos WHERE playlist_pk = ?").get(row.pk);
      out.videoCount = Number(totals.n);
      out.durationSec = Number(totals.d);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 4. Adding videos
  // -------------------------------------------------------------------------

  /** Appends clean videos (skipping ones already in the playlist) at the end (or at `at`). Returns {added, skipped}. */
  function appendVideos(pk, list, at) {
    const count = Number(db.prepare("SELECT COUNT(*) AS n FROM playlist_videos WHERE playlist_pk = ?").get(pk).n);
    const alreadyIn = new Set(db.prepare("SELECT video_id FROM playlist_videos WHERE playlist_pk = ?").all(pk).map((r) => r.video_id));

    // Drop duplicates (already in the playlist, or twice in `list`).
    const fresh = [];
    let skipped = 0;
    for (const video of list) {
      if (alreadyIn.has(video.id)) { skipped++; continue; }
      alreadyIn.add(video.id);
      fresh.push(video);
    }
    if (!fresh.length) return { added: 0, skipped };

    // Inserting in the middle: first shift the later videos down to make room.
    let position = count;
    if (Number.isInteger(at) && at >= 0 && at < count) {
      db.prepare("UPDATE playlist_videos SET position = position + ? WHERE playlist_pk = ? AND position >= ?").run(fresh.length, pk, at);
      position = at;
    }

    const insert = db.prepare("INSERT INTO playlist_videos (playlist_pk, video_id, position, title, channel, duration_sec, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const video of fresh) {
      ensureVideo(video);
      insert.run(pk, video.id, position++, video.title, video.channel, video.durationSec, video.added || nowIso());
    }
    return { added: fresh.length, skipped };
  }

  return {
    ensureVideo, findPlaylistRow, requirePlaylistRow, isNameTaken, findFreeSlug, touchPlaylist,
    videosOfPlaylist, playlistToJson, appendVideos
  };
}

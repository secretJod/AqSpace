/* playlists-repo.js - playlists and the videos inside them.

   What:  create / read / update / delete playlists, and add / edit / move / remove their videos.
   How it fits: part of the repository object (db/repository.js); called by routes/playlists.js
          and by the notes / smart services.
   Rule:  every function takes the owning userId and only touches that user's rows.
          All SQL is parameterized (the "?" placeholders).
   Read next: db/progress-repo.js */
import { tx } from "./database.js";
import { nowIso } from "../utils/time.js";
import { bad, conflict, notFound } from "../utils/http-errors.js";
import * as v from "../utils/validate.js";

/**
 * Builds the playlist functions of the repository. Every function below takes the owner's userId first
 * and throws an HttpError (400 bad input, 404 unknown playlist or video, 409 name or video conflict).
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} helpers  from createPlaylistHelpers(db)
 * @returns {object} listPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist,
 *          addVideo, addVideos, reorder, editVideo, removeVideo, userHasVideo
 */
export function createPlaylistsRepo(db, helpers) {
  const {
    findPlaylistRow,
    requirePlaylistRow,
    isNameTaken,
    findFreeSlug,
    touchPlaylist,
    videosOfPlaylist,
    playlistToJson,
    appendVideos
  } = helpers;

  /** Cleans a list of raw videos. Invalid ones are counted in `invalid` instead of throwing. */
  function cleanVideoList(list) {
    const clean = [];
    let invalid = 0;
    for (const raw of list) {
      try {
        clean.push(v.videoInput(raw));
      } catch {
        invalid++;
      }
    }
    return { clean, invalid };
  }

  const countVideos = (pk) =>
    Number(db.prepare("SELECT COUNT(*) AS n FROM playlist_videos WHERE playlist_pk = ?").get(pk).n);

  // -------------------------------------------------------------------------
  // 1. Playlists
  // -------------------------------------------------------------------------

  /** All of the user's playlists, oldest first; with `withVideos` each one includes its video list. */
  function listPlaylists(userId, { withVideos = false } = {}) {
    return db
      .prepare("SELECT * FROM playlists WHERE user_id = ? ORDER BY pk")
      .all(userId)
      .map((row) => playlistToJson(row, withVideos ? videosOfPlaylist(row.pk) : null));
  }

  /** One playlist with its videos (404 when the user has no such playlist). */
  function getPlaylist(userId, slug) {
    const row = requirePlaylistRow(userId, slug);
    return playlistToJson(row, videosOfPlaylist(row.pk));
  }

  /** body: {id?, name, description?, videos?, source?}. Returns {playlist, added, skipped}. */
  function createPlaylist(userId, body) {
    const name = v.name(body.name),
      description = v.description(body.description),
      source = v.source(body.source);
    if (body.videos != null && !Array.isArray(body.videos)) throw bad("videos must be a list.");
    if ((body.videos || []).length > v.LIMITS.batch) throw bad(`At most ${v.LIMITS.batch} videos per request.`);

    return tx(db, () => {
      if (isNameTaken(userId, name)) throw conflict("You already have a playlist with this name.");

      // Use the id the client asked for when it is free; otherwise derive one.
      let slug;
      if (body.id != null) {
        slug = v.slug(body.id);
        if (findPlaylistRow(userId, slug)) slug = findFreeSlug(userId, slug);
      } else {
        slug = findFreeSlug(userId, name);
      }

      const now = nowIso();
      const pk = Number(
        db
          .prepare(
            "INSERT INTO playlists (user_id, slug, name, description, source_list_id, source_imported_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            userId,
            slug,
            name,
            description,
            source ? source.listId : null,
            source ? source.importedAt || now : null,
            now,
            now
          ).lastInsertRowid
      );

      const { clean, invalid } = cleanVideoList(body.videos || []);
      const result = appendVideos(pk, clean, null);
      return {
        playlist: playlistToJson(findPlaylistRow(userId, slug), videosOfPlaylist(pk)),
        added: result.added,
        skipped: invalid + result.skipped
      };
    });
  }

  /** body: {name?, description?} (at least one). Returns the updated playlist; 409 when the new name is taken. */
  function updatePlaylist(userId, slug, body) {
    return tx(db, () => {
      const row = requirePlaylistRow(userId, slug);
      const name = body.name !== undefined ? v.name(body.name) : row.name;
      const description = body.description !== undefined ? v.description(body.description) : row.description;
      if (body.name === undefined && body.description === undefined)
        throw bad("Nothing to update (send name and/or description).");
      const nameChanged = name.toLowerCase() !== row.name.toLowerCase();
      if (nameChanged && isNameTaken(userId, name, row.pk))
        throw conflict("You already have a playlist with this name.");

      db.prepare("UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE pk = ?").run(
        name,
        description,
        nowIso(),
        row.pk
      );
      return playlistToJson(findPlaylistRow(userId, slug), videosOfPlaylist(row.pk));
    });
  }

  /** Deletes the playlist; its videos, and its smart runs, go with it (ON DELETE CASCADE). */
  function deletePlaylist(userId, slug) {
    const result = db.prepare("DELETE FROM playlists WHERE user_id = ? AND slug = ?").run(userId, slug);
    if (!result.changes) throw notFound("Playlist not found.");
  }

  // -------------------------------------------------------------------------
  // 2. Videos inside a playlist
  // -------------------------------------------------------------------------

  /** One video (409 when already in the playlist) -> the stored video. */
  function addVideo(userId, slug, body) {
    const video = v.videoInput(body);
    const at = body.position === undefined ? null : body.position;
    if (at !== null && (!Number.isInteger(at) || at < 0)) throw bad("position must be a non-negative integer.");
    return tx(db, () => {
      const row = requirePlaylistRow(userId, slug);
      const result = appendVideos(row.pk, [video], at);
      if (!result.added) throw conflict("This video is already in the playlist.");
      touchPlaylist(row.pk);
      return videosOfPlaylist(row.pk).find((q) => q.id === video.id);
    });
  }

  /** Batch: invalid entries and duplicates are skipped and counted. */
  function addVideos(userId, slug, list) {
    if (!Array.isArray(list)) throw bad("videos must be a list.");
    if (list.length > v.LIMITS.batch) throw bad(`At most ${v.LIMITS.batch} videos per request.`);
    return tx(db, () => {
      const row = requirePlaylistRow(userId, slug);
      const { clean, invalid } = cleanVideoList(list);
      const result = appendVideos(row.pk, clean, null);
      if (result.added) touchPlaylist(row.pk);
      return {
        added: result.added,
        skipped: invalid + result.skipped,
        playlist: playlistToJson(findPlaylistRow(userId, slug), null)
      };
    });
  }

  /** order = the playlist's video ids in the new order (must be exactly the current set). */
  function reorder(userId, slug, order) {
    if (!Array.isArray(order) || order.length > 5000) throw bad("order must be a list of video ids.");
    order.forEach(v.videoId);
    return tx(db, () => {
      const row = requirePlaylistRow(userId, slug);
      const current = db
        .prepare("SELECT video_id FROM playlist_videos WHERE playlist_pk = ?")
        .all(row.pk)
        .map((r) => r.video_id);
      const sameSet =
        order.length === current.length &&
        new Set(order).size === order.length &&
        order.every((id) => current.includes(id));
      if (!sameSet) throw bad("order must list every video of the playlist exactly once.");

      const setPosition = db.prepare("UPDATE playlist_videos SET position = ? WHERE playlist_pk = ? AND video_id = ?");
      order.forEach((id, index) => setPosition.run(index, row.pk, id));
      touchPlaylist(row.pk);
      return getPlaylist(userId, slug);
    });
  }

  /** Change title / channel / duration and optionally move the video to `position`. */
  function editVideo(userId, slug, vid, body) {
    v.videoId(vid);
    return tx(db, () => {
      const row = requirePlaylistRow(userId, slug);
      const current = db
        .prepare("SELECT * FROM playlist_videos WHERE playlist_pk = ? AND video_id = ?")
        .get(row.pk, vid);
      if (!current) throw notFound("Video not in this playlist.");

      const title =
        body.title !== undefined
          ? v.text(body.title).slice(0, v.LIMITS.title) || `YouTube video ${vid}`
          : current.title;
      const channel = body.channel !== undefined ? v.text(body.channel).slice(0, v.LIMITS.channel) : current.channel;
      const durationGiven = body.duration !== undefined || body.durationSec !== undefined;
      const duration = durationGiven
        ? v.durationSec(body.durationSec !== undefined ? body.durationSec : body.duration)
        : current.duration_sec;
      db.prepare(
        "UPDATE playlist_videos SET title = ?, channel = ?, duration_sec = ? WHERE playlist_pk = ? AND video_id = ?"
      ).run(title, channel, duration, row.pk, vid);

      if (body.position !== undefined) moveVideo(row.pk, vid, current.position, body.position);
      touchPlaylist(row.pk);
      return videosOfPlaylist(row.pk).find((q) => q.id === vid);
    });
  }

  /** Moves one video from `from` to `requested` and shifts the videos in between by one. */
  function moveVideo(pk, vid, from, requested) {
    if (!Number.isInteger(requested) || requested < 0) throw bad("position must be a non-negative integer.");
    const to = Math.min(requested, countVideos(pk) - 1);
    if (to > from) {
      // moving down: the videos between close the gap upwards
      db.prepare(
        "UPDATE playlist_videos SET position = position - 1 WHERE playlist_pk = ? AND position > ? AND position <= ?"
      ).run(pk, from, to);
    } else if (to < from) {
      // moving up: the videos between move one place down
      db.prepare(
        "UPDATE playlist_videos SET position = position + 1 WHERE playlist_pk = ? AND position >= ? AND position < ?"
      ).run(pk, to, from);
    }
    db.prepare("UPDATE playlist_videos SET position = ? WHERE playlist_pk = ? AND video_id = ?").run(to, pk, vid);
  }

  /** Removes one video from the playlist (404 when it is not in it). */
  function removeVideo(userId, slug, vid) {
    v.videoId(vid);
    tx(db, () => {
      const row = requirePlaylistRow(userId, slug);
      const current = db
        .prepare("SELECT position FROM playlist_videos WHERE playlist_pk = ? AND video_id = ?")
        .get(row.pk, vid);
      if (!current) throw notFound("Video not in this playlist.");
      db.prepare("DELETE FROM playlist_videos WHERE playlist_pk = ? AND video_id = ?").run(row.pk, vid);
      // close the gap so positions stay 0, 1, 2, ...
      db.prepare("UPDATE playlist_videos SET position = position - 1 WHERE playlist_pk = ? AND position > ?").run(
        row.pk,
        current.position
      );
      touchPlaylist(row.pk);
    });
  }

  /** Is this video in any of the user's playlists? (permission check for starting notes) */
  function userHasVideo(userId, vid) {
    return !!db
      .prepare(
        "SELECT 1 FROM playlist_videos pv JOIN playlists p ON p.pk = pv.playlist_pk WHERE p.user_id = ? AND pv.video_id = ? LIMIT 1"
      )
      .get(userId, vid);
  }

  return {
    listPlaylists,
    getPlaylist,
    createPlaylist,
    updatePlaylist,
    deletePlaylist,
    addVideo,
    addVideos,
    reorder,
    editVideo,
    removeVideo,
    userHasVideo
  };
}

/* playlists.js - /api/v1/playlists : playlists and their videos.

   What:  reads ids from the URL, checks them, and calls the repository.
   How it fits: mounted in routes/index.js; the work happens in db/playlists-repo.js.
   Read next: routes/progress.js */
import { Router } from "express";
import { bad } from "../utils/http-errors.js";
import { isObj, slug, videoId } from "../utils/validate.js";

/** The JSON body, or a 400 when it is not an object. */
function jsonBody(req) {
  if (!isObj(req.body)) throw bad("Send a JSON object (Content-Type: application/json).");
  return req.body;
}

const userIdOf = (req) => req.user.id;

/**
 * @param {object} repo  the repository (db/playlists-repo.js functions)
 * @returns {import("express").Router}
 */
export function playlistRoutes(repo) {
  const router = Router();

  // -------------------------------------------------------------------------
  // 1. Playlists
  // -------------------------------------------------------------------------

  /** GET /playlists[?include=videos] - {playlists: [...]}. */
  router.get("/playlists", (req, res) => {
    res.json({ playlists: repo.listPlaylists(userIdOf(req), { withVideos: req.query.include === "videos" }) });
  });

  /** POST /playlists - body {id?, name, description?, videos?, source?}; 201 {playlist, added, skipped}; 409 name taken. */
  router.post("/playlists", (req, res) => {
    res.status(201).json(repo.createPlaylist(userIdOf(req), jsonBody(req)));
  });

  /** GET /playlists/:id - {playlist} with its videos; 404 when unknown. */
  router.get("/playlists/:id", (req, res) => {
    res.json({ playlist: repo.getPlaylist(userIdOf(req), slug(req.params.id)) });
  });

  /** PATCH /playlists/:id - body {name?, description?}; {playlist}. */
  router.patch("/playlists/:id", (req, res) => {
    res.json({ playlist: repo.updatePlaylist(userIdOf(req), slug(req.params.id), jsonBody(req)) });
  });

  /** DELETE /playlists/:id - 204. */
  router.delete("/playlists/:id", (req, res) => {
    repo.deletePlaylist(userIdOf(req), slug(req.params.id));
    res.status(204).end();
  });

  // -------------------------------------------------------------------------
  // 2. Videos inside a playlist
  // -------------------------------------------------------------------------

  /**
   * POST /playlists/:id/videos - one video {id, title, channel, duration, position?} -> 201 {video} (409 when
   * already there), or a batch {videos: [...]} -> 200 {added, skipped, playlist}.
   */
  router.post("/playlists/:id/videos", (req, res) => {
    const body = jsonBody(req),
      playlistId = slug(req.params.id);
    if (body.videos !== undefined) return res.json(repo.addVideos(userIdOf(req), playlistId, body.videos));
    res.status(201).json({ video: repo.addVideo(userIdOf(req), playlistId, body) });
  });

  /** PUT /playlists/:id/videos/order - body {order: [videoId, ...]} listing every video once; {playlist}. */
  router.put("/playlists/:id/videos/order", (req, res) => {
    res.json({ playlist: repo.reorder(userIdOf(req), slug(req.params.id), jsonBody(req).order) });
  });

  /** PATCH /playlists/:id/videos/:videoId - body {title?, channel?, duration?, position?}; {video}. */
  router.patch("/playlists/:id/videos/:videoId", (req, res) => {
    res.json({ video: repo.editVideo(userIdOf(req), slug(req.params.id), videoId(req.params.videoId), jsonBody(req)) });
  });

  /** DELETE /playlists/:id/videos/:videoId - 204; 404 when the video is not in the playlist. */
  router.delete("/playlists/:id/videos/:videoId", (req, res) => {
    repo.removeVideo(userIdOf(req), slug(req.params.id), videoId(req.params.videoId));
    res.status(204).end();
  });

  return router;
}

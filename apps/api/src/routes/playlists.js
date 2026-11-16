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

export function playlistRoutes(repo) {
  const router = Router();

  // -------------------------------------------------------------------------
  // 1. Playlists
  // -------------------------------------------------------------------------

  router.get("/playlists", (req, res) => {
    res.json({ playlists: repo.listPlaylists(userIdOf(req), { withVideos: req.query.include === "videos" }) });
  });

  router.post("/playlists", (req, res) => {
    res.status(201).json(repo.createPlaylist(userIdOf(req), jsonBody(req)));
  });

  router.get("/playlists/:id", (req, res) => {
    res.json({ playlist: repo.getPlaylist(userIdOf(req), slug(req.params.id)) });
  });

  router.patch("/playlists/:id", (req, res) => {
    res.json({ playlist: repo.updatePlaylist(userIdOf(req), slug(req.params.id), jsonBody(req)) });
  });

  router.delete("/playlists/:id", (req, res) => {
    repo.deletePlaylist(userIdOf(req), slug(req.params.id));
    res.status(204).end();
  });

  // -------------------------------------------------------------------------
  // 2. Videos inside a playlist
  // -------------------------------------------------------------------------

  // add one video ({id, title, channel, duration, position?}) or a batch ({videos: [...]})
  router.post("/playlists/:id/videos", (req, res) => {
    const body = jsonBody(req), playlistId = slug(req.params.id);
    if (body.videos !== undefined) return res.json(repo.addVideos(userIdOf(req), playlistId, body.videos));
    res.status(201).json({ video: repo.addVideo(userIdOf(req), playlistId, body) });
  });

  // reorder: {order: [videoId, ...]} (all videos of the playlist, new order)
  router.put("/playlists/:id/videos/order", (req, res) => {
    res.json({ playlist: repo.reorder(userIdOf(req), slug(req.params.id), jsonBody(req).order) });
  });

  router.patch("/playlists/:id/videos/:videoId", (req, res) => {
    res.json({ video: repo.editVideo(userIdOf(req), slug(req.params.id), videoId(req.params.videoId), jsonBody(req)) });
  });

  router.delete("/playlists/:id/videos/:videoId", (req, res) => {
    repo.removeVideo(userIdOf(req), slug(req.params.id), videoId(req.params.videoId));
    res.status(204).end();
  });

  return router;
}

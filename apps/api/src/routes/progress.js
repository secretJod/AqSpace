/* progress.js - /api/v1/progress : how far the user has watched each video.

   How it fits: mounted in routes/index.js; the work happens in db/progress-repo.js.
   Read next: routes/notes.js */
import { Router } from "express";
import { bad, notFound } from "../utils/http-errors.js";
import { isObj, videoId } from "../utils/validate.js";

/**
 * @param {object} repo  the repository (getProgress, allProgress, putProgress)
 * @returns {import("express").Router}
 */
export function progressRoutes(repo) {
  const router = Router();

  /** GET /progress - {progress: {videoId: {pos, dur, done, updated}}}. */
  router.get("/progress", (req, res) => {
    res.json({ progress: repo.allProgress(req.user.id) });
  });

  /** GET /progress/:videoId - {videoId, pos, dur, done, updated}; 404 when the video was never watched. */
  router.get("/progress/:videoId", (req, res) => {
    const progress = repo.getProgress(req.user.id, videoId(req.params.videoId));
    if (!progress) throw notFound("No progress for this video.");
    res.json({ videoId: req.params.videoId, ...progress });
  });

  /** PUT /progress/:videoId - body {pos, dur, done?, updated?}; returns the stored row (stale: true if ours was newer). */
  router.put("/progress/:videoId", (req, res) => {
    if (!isObj(req.body)) throw bad("Send a JSON object {pos, dur, done}.");
    const progress = repo.putProgress(req.user.id, videoId(req.params.videoId), req.body);
    res.json({ videoId: req.params.videoId, ...progress });
  });

  return router;
}

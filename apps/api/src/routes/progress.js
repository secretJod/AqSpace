/* progress.js - /api/v1/progress : how far the user has watched each video.

   How it fits: mounted in routes/index.js; the work happens in db/progress-repo.js.
   Read next: routes/notes.js */
import { Router } from "express";
import { bad, notFound } from "../utils/http-errors.js";
import { isObj, videoId } from "../utils/validate.js";

export function progressRoutes(repo) {
  const router = Router();

  router.get("/progress", (req, res) => {
    res.json({ progress: repo.allProgress(req.user.id) });
  });

  router.get("/progress/:videoId", (req, res) => {
    const progress = repo.getProgress(req.user.id, videoId(req.params.videoId));
    if (!progress) throw notFound("No progress for this video.");
    res.json({ videoId: req.params.videoId, ...progress });
  });

  router.put("/progress/:videoId", (req, res) => {
    if (!isObj(req.body)) throw bad("Send a JSON object {pos, dur, done}.");
    const progress = repo.putProgress(req.user.id, videoId(req.params.videoId), req.body);
    res.json({ videoId: req.params.videoId, ...progress });
  });

  return router;
}

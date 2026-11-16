/* notes.js - /api/v1/notes : lecture notes per video.

   What:  list / status / start notes, and stream the finished HTML or PDF from the worker.
   How it fits: mounted in routes/index.js; the logic lives in services/notes-service.js.
   Read next: routes/smart.js */
import { Router } from "express";
import { videoId } from "../utils/validate.js";
import { pipeFile } from "../utils/pipe-file.js";

export function notesRoutes(notes, heavyLimiter) {
  const router = Router();

  router.get("/notes", (_req, res) => {
    res.json({ notes: notes.list() });
  });

  router.get("/notes/:videoId", async (req, res) => {
    res.json(await notes.status(videoId(req.params.videoId)));
  });

  // 202 = a new job was started, 200 = existing notes / job returned
  router.post("/notes/:videoId", heavyLimiter, async (req, res) => {
    const out = await notes.start(req.user, videoId(req.params.videoId));
    res.status(out.started ? 202 : 200).json(out.status);
  });

  router.get("/notes/:videoId/html", async (req, res) => {
    const upstream = await notes.file(videoId(req.params.videoId), "html");
    // The worker's own CSP allows exactly the inline scripts in the generated page (by hash) - pass it through.
    await pipeFile(res, upstream, ["content-type", "content-security-policy", "content-length"]);
  });

  router.get("/notes/:videoId/pdf", async (req, res) => {
    const upstream = await notes.file(videoId(req.params.videoId), "pdf");
    await pipeFile(res, upstream, ["content-type", "content-disposition", "content-length"]);
  });

  return router;
}

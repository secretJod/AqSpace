/* smart.js - /api/v1/playlists/:id/smart : "smart arrange" runs (a language model orders the videos) for a playlist.

   How it fits: mounted in routes/index.js; the logic lives in services/smart-service.js.
   Read next: routes/youtube-import.js */
import { Router } from "express";
import { slug } from "../utils/validate.js";

/**
 * @param {object} smart  the smart service (services/smart-service.js)
 * @param {import("express").RequestHandler} heavyLimiter  rate limit for starting runs
 * @returns {import("express").Router}
 */
export function smartRoutes(smart, heavyLimiter) {
  const router = Router();

  /** GET /playlists/:id/smart - the latest run of the playlist (state "none" when there is none). */
  router.get("/playlists/:id/smart", async (req, res) => {
    res.json(await smart.status(req.user, slug(req.params.id)));
  });

  /**
   * POST /playlists/:id/smart - starts a run. 202 = a new run was started, 200 = an identical run already exists.
   * Errors: 404 unknown playlist, 422 too few or too many videos, 429 worker busy, 503 py_offline.
   */
  router.post("/playlists/:id/smart", heavyLimiter, async (req, res) => {
    const out = await smart.start(req.user, slug(req.params.id));
    res.status(out.started ? 202 : 200).json(out.status);
  });

  return router;
}

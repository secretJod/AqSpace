/* smart.js - /api/v1/playlists/:id/smart : AI "smart arrange" runs for a playlist.

   How it fits: mounted in routes/index.js; the logic lives in services/smart-service.js.
   Read next: routes/youtube-import.js */
import { Router } from "express";
import { slug } from "../utils/validate.js";

export function smartRoutes(smart, heavyLimiter) {
  const router = Router();

  router.get("/playlists/:id/smart", async (req, res) => {
    res.json(await smart.status(req.user, slug(req.params.id)));
  });

  // 202 = a new run was started, 200 = an identical run already exists
  router.post("/playlists/:id/smart", heavyLimiter, async (req, res) => {
    const out = await smart.start(req.user, slug(req.params.id));
    res.status(out.started ? 202 : 200).json(out.status);
  });

  return router;
}

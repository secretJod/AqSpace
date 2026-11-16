/* sync.js - POST /api/v1/sync/import : one-time / recovery import of the browser's data.

   What:  hands the body to repo.importState() and returns the resulting state.
   How it fits: mounted in routes/index.js BEFORE the shared express.json() parser,
          because it needs a bigger body limit (2mb) than the rest of the API.
   Read next: db/sync-import-repo.js */
import express, { Router } from "express";

export function syncRoutes(repo) {
  const router = Router();
  router.post("/sync/import", express.json({ limit: "2mb" }), (req, res) => {
    res.json(repo.importState(req.user.id, req.body));
  });
  return router;
}

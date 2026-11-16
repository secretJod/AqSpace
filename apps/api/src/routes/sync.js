/* sync.js - POST /api/v1/sync/import : one-time / recovery import of the browser's data.

   What:  hands the body to repo.importState() and returns the resulting state.
   How it fits: mounted in routes/index.js BEFORE the shared express.json() parser,
          because it needs a bigger body limit (2mb) than the rest of the API.
   Read next: db/sync-import-repo.js */
import express, { Router } from "express";

/**
 * @param {object} repo  the repository (importState)
 * @returns {import("express").Router}
 */
export function syncRoutes(repo) {
  const router = Router();
  /** POST /sync/import - body {mode?, playlists, progress}; returns {playlists, progress}. 400 for a bad body. */
  router.post("/sync/import", express.json({ limit: "2mb" }), (req, res) => {
    res.json(repo.importState(req.user.id, req.body));
  });
  return router;
}

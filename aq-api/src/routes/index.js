/* routes/index.js - builds the /api/v1 router from the per-area routers.

   What:  one place that shows every API area and the ORDER the middleware runs in.
   How it fits: app.js mounts the result at "/api/v1".
   Order matters:
     1. general rate limit
     2. /health                 (no login)
     3. authenticate            (sets req.user)
     4. /me, /sync/import       (sync has its own 2mb JSON parser, so it comes before the shared one)
     5. express.json()          (shared body parser, config.bodyLimit)
     6. playlists, progress, notes, smart, YouTube import
     7. anything else -> 404
   Read next: routes/playlists.js */
import express from "express";
import { notFoundHandler } from "../middleware/error-handler.js";
import { healthRoutes } from "./health.js";
import { meRoutes } from "./me.js";
import { syncRoutes } from "./sync.js";
import { playlistRoutes } from "./playlists.js";
import { progressRoutes } from "./progress.js";
import { notesRoutes } from "./notes.js";
import { smartRoutes } from "./smart.js";
import { youtubeImportRoutes } from "./youtube-import.js";

export function createApiRouter({ db, repo, py, notes, smart, config, authenticate, generalLimiter, heavyLimiter, version }) {
  const api = express.Router();

  api.use(generalLimiter);
  api.use(healthRoutes({ db, py, version }));
  api.use(authenticate);
  api.use(meRoutes(repo));
  api.use(syncRoutes(repo));
  api.use(express.json({ limit: config.bodyLimit }));
  api.use(playlistRoutes(repo));
  api.use(progressRoutes(repo));
  api.use(notesRoutes(notes, heavyLimiter));
  api.use(smartRoutes(smart, heavyLimiter));
  api.use(youtubeImportRoutes(py, config, heavyLimiter));
  api.use(notFoundHandler);

  return api;
}

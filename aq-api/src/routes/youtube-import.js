/* youtube-import.js - GET /api/v1/import/youtube?url=... : read a YouTube playlist.

   What:  takes the user's playlist link, extracts the list id, and asks the Python worker
          for the playlist's videos.
   Safety: only the validated list id is forwarded (as a fresh canonical URL), never the user's URL.
   How it fits: mounted in routes/index.js with the "heavy" rate limiter.
   Read next: routes/playlists.js */
import { Router } from "express";
import { HttpError } from "../utils/http-errors.js";
import { LIST_ID_RE } from "../utils/validate.js";

export function youtubeImportRoutes(py, config, heavyLimiter) {
  const router = Router();

  router.get("/import/youtube", heavyLimiter, async (req, res) => {
    const listId = listIdFromUrl(req.query.url);
    const canonical = "https://www.youtube.com/playlist?list=" + listId;
    const answer = await py.json("/api/playlist?url=" + encodeURIComponent(canonical), { timeout: config.notes.importTimeoutMs });

    if (answer.status !== 200 || !answer.json) {
      const message = answer.json && typeof answer.json.error === "string"
        ? answer.json.error.slice(0, 300)
        : `The notes service could not read that playlist (status ${answer.status}).`;
      const clientProblem = answer.status >= 400 && answer.status < 500 && answer.status !== 404;
      throw new HttpError(clientProblem ? 422 : 502, message);
    }
    res.json(answer.json);
  });

  return router;
}

/** "https://youtube.com/playlist?list=PL..." -> "PL..." or a 400. */
function listIdFromUrl(value) {
  const url = typeof value === "string" ? value : "";
  if (!url || url.length > 2048) throw new HttpError(400, "Paste a YouTube playlist link.");
  const match = /[?&]list=([A-Za-z0-9_-]{10,64})(?:[&#]|$)/.exec(url);
  if (!match || !LIST_ID_RE.test(match[1])) throw new HttpError(400, "That doesn't look like a playlist link (it should contain list=...).");
  return match[1];
}

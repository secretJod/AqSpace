/* fonts.js - GET /static/fonts/<file> (outside /api).

   What:  the generated notes page references /static/fonts/<file>; we fetch those from the worker.
   How it fits: mounted directly on the app in app.js (not under /api/v1, no login).
   Read next: routes/ui-static.js */
import { Router } from "express";
import { pipeFile } from "../utils/pipe-file.js";

const FONT_FILE_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function fontRoutes(py) {
  const router = Router();

  router.get("/static/fonts/:file", async (req, res) => {
    const file = req.params.file;
    if (!FONT_FILE_RE.test(file) || file.includes("..")) return res.status(404).end();

    const upstream = await py.raw(`/static/fonts/${file}`);
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return res.status(404).end();
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    await pipeFile(res, upstream, ["content-type", "content-length"]);
  });

  return router;
}

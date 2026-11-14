/* health.js - GET /api/v1/health  (no login needed)

   What:  reports whether the database works; with ?deep=1 it also asks the Python worker.
   How it fits: mounted in routes/index.js before the authentication middleware.
   Read next: routes/me.js */
import { Router } from "express";

export function healthRoutes({ db, py, version }) {
  const router = Router();

  router.get("/health", async (req, res) => {
    let dbOk = true;
    try { db.prepare("SELECT 1").get(); } catch { dbOk = false; }
    const out = { ok: dbOk, service: "aq-api", version, uptimeSec: Math.round(process.uptime()), db: dbOk ? "ok" : "error" };

    if (req.query.deep === "1") {
      // The worker has no /api/health; /api/providers is cheap and proves it answers.
      try {
        const answer = await py.json("/api/providers", { timeout: 2000 });
        out.notesService = answer.status === 200 ? "ok" : "error";
      } catch {
        out.notesService = "offline";
      }
    }
    res.status(dbOk ? 200 : 503).json(out);
  });

  return router;
}

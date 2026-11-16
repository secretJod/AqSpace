/* health.js - GET /api/v1/health  (no login needed)

   What:  reports whether the database works; with ?deep=1 it also asks the Python worker and adds
          `notesService`, `localModel` (is the local LLM up, as the worker reports it) and `dbBusy`
          (the SQLite write-contention counter, see db/database.js).
   How it fits: mounted in routes/index.js before the authentication middleware.
   Read next: routes/me.js */
import { Router } from "express";
import { dbBusy } from "../db/database.js";

/* The worker's /api/providers lists {id: "local", online: bool, ...}; "ok" only when the worker says its local
   model server answers. The API never calls the model server itself: the worker is its only client. */
function localModelState(json) {
  const list = json && Array.isArray(json.providers) ? json.providers : [];
  const p = list.find((x) => x && x.id === "local");
  if (!p) return "offline";
  return p.online === true || p.available === true || p.ok === true || p.status === "ok" ? "ok" : "offline";
}

/**
 * @param {object} deps
 * @param {import("node:sqlite").DatabaseSync} deps.db
 * @param {object} deps.py  the worker client
 * @param {string} deps.version  reported as `version`
 * @returns {import("express").Router}
 */
export function healthRoutes({ db, py, version }) {
  const router = Router();

  /** GET /health[?deep=1] - 200 {ok: true, ...} when the database answers, 503 when it does not. */
  router.get("/health", async (req, res) => {
    let dbOk = true;
    try {
      db.prepare("SELECT 1").get();
    } catch {
      dbOk = false;
    }
    const out = {
      ok: dbOk,
      service: "aq-api",
      version,
      uptimeSec: Math.round(process.uptime()),
      db: dbOk ? "ok" : "error"
    };

    if (req.query.deep === "1") {
      out.dbBusy = dbBusy(db);
      out.localModel = "offline";
      // The worker has no /api/health; /api/providers is cheap and proves it answers.
      try {
        const answer = await py.json("/api/providers", { timeout: 2000 });
        out.notesService = answer.status === 200 ? "ok" : "error";
        if (answer.status === 200) out.localModel = localModelState(answer.json);
      } catch {
        out.notesService = "offline";
      }
    }
    res.status(dbOk ? 200 : 503).json(out);
  });

  return router;
}

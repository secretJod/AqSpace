/* dev-router.js - everything under /dev: JSON endpoints for the developer pages + the pages themselves.

   What:  /dev/api/overview   services up?, counts, recent errors
          /dev/api/requests   live request ring buffer (poll with ?since=<seq>)
          /dev/api/events     live job state changes
          /dev/api/jobs       last 50 notes + smart jobs from the database
          /dev/api/history/days, /history, /export, /stats   saved JSONL history
          /dev/api/logs/:service   tail of .run/*.log (api or worker), secrets masked
          /dev/*              static pages from apps/api/dev-ui/
   Rules: read-only (GET/HEAD only), its own strict CSP, never cached.
   How it fits: mounted at "/dev" in app.js when the tracker is enabled.
   Read next: dev/tracker.js */
import express, { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError } from "../utils/http-errors.js";
import { DAY_RE } from "./dev-log-store.js";
import { filterEntries, toCsv, computeStats } from "./history-tools.js";
import { LOG_FILES, tailFile } from "./service-logs.js";

// apps/api/dev-ui (this file lives in apps/api/src/dev/)
const DEV_UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dev-ui");

export const CSP_DEV = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// ---------------------------------------------------------------------------
// 1. Small helpers
// ---------------------------------------------------------------------------

/** Whole number from a query value, between 0 and max; otherwise `fallback`. */
const queryInt = (value, fallback, max) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
};

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** DB status -> UI state name. */
const publicState = (status) => (status === "done" ? "ready" : status === "expired" ? "none" : status);

/** Milliseconds between two ISO times, or null. */
const durationMs = (from, to) => (from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : null);

/** Same rule as history-tools isError, but without network errors (status 0). */
const isRecentError = (e) => e.layer !== "dev" && (e.status >= 500 || (e.status >= 400 && !(e.status === 404 && e.layer === "ui")));

/** ?type=requests|events&date=YYYY-MM-DD (date defaults to today), or a 400. */
function historyArgs(query) {
  const type = query.type || "requests", date = query.date || todayUtc();
  if (type !== "requests" && type !== "events") throw new HttpError(400, "type must be requests or events.");
  if (typeof date !== "string" || !DAY_RE.test(date)) throw new HttpError(400, "date must be YYYY-MM-DD.");
  return { type, date };
}

// ---------------------------------------------------------------------------
// 2. Overview data
// ---------------------------------------------------------------------------

/** Is the worker answering? (it has no /api/health; routes/health.js probes /api/providers too) */
async function probeWorker(py) {
  const startedAt = Date.now();
  try {
    const answer = await py.json("/api/providers", { timeout: 1500 });
    return { ok: answer.status === 200, latencyMs: Date.now() - startedAt, error: answer.status === 200 ? null : `status ${answer.status}` };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: e.code === "py_offline" ? "offline" : "error" };
  }
}

function countRecords(db) {
  const single = (sql) => db.prepare(sql).get().n;
  // Runs a "SELECT <state> AS s, COUNT(*) AS n ..." query and fills the counts for `keys` (missing = 0).
  const byState = (sql, keys) => {
    const out = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const row of db.prepare(sql).all()) if (row.s in out) out[row.s] += row.n;
    return out;
  };
  // notes: latest record per video; smart: latest run per playlist (playlists without a run = none)
  const notes = byState(`SELECT CASE status WHEN 'done' THEN 'ready' ELSE status END AS s, COUNT(*) AS n FROM notes_jobs
      WHERE id IN (SELECT MAX(id) FROM notes_jobs GROUP BY video_id) AND status <> 'expired' GROUP BY s`, ["queued", "running", "ready", "error"]);
  const smart = byState(`SELECT COALESCE(CASE s.status WHEN 'done' THEN 'ready' ELSE s.status END, 'none') AS s, COUNT(*) AS n FROM playlists p
      LEFT JOIN smart_runs s ON s.id = (SELECT MAX(id) FROM smart_runs WHERE playlist_pk = p.pk) GROUP BY 1`, ["none", "queued", "running", "ready", "error"]);
  return { playlists: single("SELECT COUNT(*) AS n FROM playlists"), videos: single("SELECT COUNT(*) AS n FROM videos"), notes, smart };
}

// ---------------------------------------------------------------------------
// 3. Jobs list
// ---------------------------------------------------------------------------

function recentJobs(db) {
  const notes = db.prepare("SELECT id, job_id, video_id, status, stage, pct, error, created_at, updated_at FROM notes_jobs ORDER BY id DESC LIMIT 50").all()
    .map((j) => ({
      kind: "notes", id: j.job_id, videoId: j.video_id, playlistId: null, state: publicState(j.status), stage: j.stage, pct: j.status === "done" ? 100 : j.pct,
      provider: null, model: null, startedAt: j.created_at, updatedAt: j.updated_at, durationMs: durationMs(j.created_at, j.updated_at), error: j.error || null
    }));
  const smart = db.prepare("SELECT s.job_id, p.slug, s.status, s.stage, s.pct, s.error, s.provider, s.model, s.created_at, s.updated_at FROM smart_runs s JOIN playlists p ON p.pk = s.playlist_pk ORDER BY s.id DESC LIMIT 50").all()
    .map((j) => ({
      kind: "smart", id: j.job_id, videoId: null, playlistId: j.slug, state: publicState(j.status), stage: j.stage, pct: j.status === "done" ? 100 : j.pct,
      provider: j.provider || null, model: j.model || null, startedAt: j.created_at, updatedAt: j.updated_at, durationMs: durationMs(j.created_at, j.updated_at), error: j.error || null
    }));
  return [...notes, ...smart].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")).slice(0, 50);
}

// ---------------------------------------------------------------------------
// 4. The router
// ---------------------------------------------------------------------------

export function devRoutes({ db, py, tracker, runDir = "" }) {
  const router = Router();

  const requireLog = () => {
    if (!tracker.log) throw new HttpError(404, "Persistent dev logs are disabled (AQ_DEVLOG_DIR is empty).");
    return tracker.log;
  };

  // 4.1 Rules for every /dev reply
  router.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", CSP_DEV);
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use((req, _res, next) => (req.method === "GET" || req.method === "HEAD" ? next() : next(new HttpError(405, "Method not allowed."))));

  // 4.2 Live data
  router.get("/api/overview", async (_req, res) => {
    const worker = await probeWorker(py);
    const counts = countRecords(db);
    const recentErrors = tracker.requests.all().filter(isRecentError).slice(-10).map((e) => ({ ts: e.ts, path: e.path, status: e.status }));
    const mem = process.memoryUsage();
    res.json({
      generatedAt: new Date().toISOString(),
      services: { api: { ok: true, uptimeSec: Math.round(process.uptime()), pid: process.pid, rssMb: Math.round(mem.rss / 1048576), node: process.version }, worker },
      counts,
      recentErrors
    });
  });

  router.get("/api/requests", (req, res) => {
    const includeDev = req.query.include_dev === "1";
    const since = queryInt(req.query.since, 0, Number.MAX_SAFE_INTEGER);
    const limit = queryInt(req.query.limit, 200, 500) || 200;
    const items = tracker.requests.since(since, limit, (e) => includeDev || e.layer !== "dev");
    res.json({ items, last: tracker.requests.last });
  });

  router.get("/api/events", (req, res) => {
    res.json({ items: tracker.events.since(queryInt(req.query.since, 0, Number.MAX_SAFE_INTEGER), 500), last: tracker.events.last });
  });

  router.get("/api/jobs", (_req, res) => {
    res.json({ items: recentJobs(db) });
  });

  // 4.3 Saved history (data/devlogs)
  router.get("/api/history/days", async (_req, res) => {
    res.json({ keepDays: tracker.keepDays, items: await requireLog().days() });
  });

  router.get("/api/history", async (req, res) => {
    const { type, date } = historyArgs(req.query);
    const log = requireLog();
    const all = filterEntries(type, await log.read(type, date), req.query).reverse();   // newest first
    const limit = queryInt(req.query.limit, 100, 1000) || 100, offset = queryInt(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
    res.json({ type, date, total: all.length, offset, limit, items: all.slice(offset, offset + limit) });
  });

  router.get("/api/export", async (req, res) => {
    const { type, date } = historyArgs(req.query);
    const log = requireLog();
    const format = req.query.format === "jsonl" ? "jsonl" : req.query.format === "csv" || req.query.format == null ? "csv" : null;
    if (!format) throw new HttpError(400, "format must be csv or jsonl.");
    const items = filterEntries(type, await log.read(type, date), req.query);
    res.setHeader("Content-Disposition", `attachment; filename="aq-${type}-${date}.${format}"`);
    res.type(format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8");
    res.send(format === "csv" ? toCsv(type, items) : items.map((e) => JSON.stringify(e) + "\n").join(""));
  });

  router.get("/api/stats", async (req, res) => {
    const { date } = historyArgs({ type: "requests", date: req.query.date });
    const items = filterEntries("requests", await requireLog().read("requests", date), { layer: req.query.layer });
    res.json({ date, ...computeStats(items) });
  });

  // 4.4 Service console logs (.run/*.log written by start-all.ps1)
  router.get("/api/logs/:service", async (req, res) => {
    const files = LOG_FILES[req.params.service];
    if (!files) throw new HttpError(404, "Unknown service (api or worker).");
    if (!runDir) throw new HttpError(404, "Service log capture is not configured (AQ_RUN_DIR).");
    const tail = queryInt(req.query.tail, 200, 2000) || 200;
    const previousRun = req.query.run === "prev";        // start-all.ps1 keeps the previous run as *.prev.log
    const streams = {};
    for (const [stream, fileName] of Object.entries(files)) {
      const name = previousRun ? fileName.replace(/\.log$/, ".prev.log") : fileName;
      streams[stream] = await tailFile(path.join(runDir, name), tail);
    }
    res.json({ service: req.params.service, run: previousRun ? "prev" : "current", generatedAt: new Date().toISOString(), tail, streams });
  });

  router.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found.")));

  // 4.5 The dev pages (dev-ui/): simple file names only
  if (fs.existsSync(DEV_UI_DIR)) {
    router.use((req, _res, next) => (/^\/[A-Za-z0-9_-]*(\.(html|js|css|svg|png|json))?$/.test(req.path) ? next() : next(new HttpError(404, "Not found."))));
    router.use(express.static(DEV_UI_DIR, { index: "index.html", dotfiles: "ignore", etag: true, maxAge: 0, redirect: false, fallthrough: true }));
  }
  return router;
}

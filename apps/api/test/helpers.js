/* helpers.js - shared test tools: startApp() runs the real app on a random port with an in-memory database,
   startMockPython() is a small stand-in for the Python worker. VID(n) and JOB(n) make valid ids. */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/load-config.js";
import { createApp } from "../src/app.js";

export const VID = (n) => String(n).padStart(11, "a"); // valid 11-char ids: aaaaaaaaaa1 ...
export const JOB = (n) => String(n).padStart(32, "0"); // valid 32-hex job ids
// A fixed test-only master secret for encrypted AI keys (never the real data/.key-secret).
export const TEST_KEY_SECRET = Buffer.alloc(32, 7).toString("base64");
export const ALL_SERVER_KEYS = () => ({ gemini: true, groq: true, nvidia: true, xai: true, huggingface: true });

function listen(server) {
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port)));
}

/** A tiny stand-in for the Python notes service. `py.state` can be changed by tests. */
export async function startMockPython() {
  const state = {
    jobsCreated: [],
    nextJob: 1,
    jobs: new Map(), // jobId -> {status, pct}
    busy: false,
    rejectWith: null,
    playlistUrls: [],
    hits: { status: 0, html: 0, providers: 0 },
    providers: [], // extra /api/providers entries (e.g. the local model)
    providersStatus: 200,
    serverKeys: ALL_SERVER_KEYS(), // provider -> the worker has its own .env key
    keyTests: [], // bodies of POST /api/keys/test
    askBodies: [], // bodies of POST /api/ask
    // -> [status, body]; by default cites the first job it was given at 75.4 s
    askAnswer: (body) => [
      200,
      {
        answer: "From your notes: " + body.jobs.length,
        found: true,
        citations: body.jobs
          .slice(0, 1)
          .map((j) => ({ video_id: j.video_id, title: j.title, heading: "Intro", start_sec: 75.4 })),
        used_notes: body.jobs.length,
        provider: body.provider
      }
    ],
    keyTestAnswer: (body) =>
      body.api_key.includes("BAD")
        ? { ok: false, kind: "invalid", error: "That key was rejected by the provider." }
        : { ok: true }
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (code, o) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    let m;
    if (req.method === "POST" && u.pathname === "/api/jobs") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        if (state.busy) return json(429, { error: "busy" });
        if (state.rejectWith) return json(400, { error: state.rejectWith });
        const body = JSON.parse(b);
        const id = JOB(state.nextJob++);
        state.jobsCreated.push({ id, body });
        state.jobs.set(id, { status: "running", pct: 40 });
        json(202, { job_id: id });
      });
    } else if ((m = /^\/api\/jobs\/([a-f0-9]{32})$/.exec(u.pathname)) && req.method === "GET") {
      state.hits.status++;
      const j = state.jobs.get(m[1]);
      if (!j) return json(404, { error: "Job not found" });
      json(200, {
        status: j.status,
        pct: j.pct,
        stage: j.stage ?? "x",
        message: j.message ?? "m",
        job_id: m[1],
        ...(j.error ? { error: j.error } : {}),
        ...(j.chunk != null ? { chunk: j.chunk, chunks: j.chunks } : {}),
        ...(j.pages != null ? { pages: j.pages } : {})
      });
    } else if ((m = /^\/api\/jobs\/([a-f0-9]{32})\/draft\.html$/.exec(u.pathname))) {
      const j = state.jobs.get(m[1]);
      if (!j || !j.pages) return json(404, { error: "No pages yet." });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'"
      });
      res.end(`<h1>draft ${j.pages}</h1>`);
    } else if ((m = /^\/api\/jobs\/([a-f0-9]{32})\/notes\.(html|pdf)$/.exec(u.pathname))) {
      if (m[2] === "html") state.hits.html++;
      const j = state.jobs.get(m[1]);
      if (!j || j.status !== "done") return json(404, { error: "File not found." });
      if (m[2] === "html") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'"
        });
        res.end(req.method === "HEAD" ? undefined : "<h1>notes</h1>");
      } else {
        res.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="n.pdf"'
        });
        res.end(req.method === "HEAD" ? undefined : "%PDF-1.4 fake");
      }
    } else if (u.pathname === "/api/playlist") {
      state.playlistUrls.push(u.searchParams.get("url"));
      json(200, {
        id: "PLabcdefghij",
        title: "T",
        channel: "C",
        count: 1,
        videos: [{ id: VID(1), title: "v", channel: "C", duration_sec: 61 }],
        truncated: false,
        skipped: 0
      });
    } else if (u.pathname === "/api/providers") {
      state.hits.providers++;
      const withKeys = Object.entries(state.serverKeys).map(([id, k]) => ({ id, label: id, server_key: k }));
      json(state.providersStatus, { providers: [...state.providers, ...withKeys] });
    } else if (req.method === "POST" && u.pathname === "/api/keys/test") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const body = JSON.parse(b);
        state.keyTests.push(body);
        json(200, state.keyTestAnswer(body));
      });
    } else if (req.method === "POST" && u.pathname === "/api/ask") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const body = JSON.parse(b);
        state.askBodies.push(body);
        json(...state.askAnswer(body));
      });
    } else if (/^\/static\/fonts\/([A-Za-z0-9._-]+)$/.test(u.pathname)) {
      res.writeHead(200, { "content-type": "font/woff2" });
      res.end("font");
    } else json(404, { error: "nope" });
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      })
  };
}

/** Starts the real app on a random port with an in-memory database. */
export async function startApp({
  py,
  overrides = {},
  authenticate,
  clock,
  fetchImpl,
  googleFetch,
  withUi = false
} = {}) {
  let uiDir = "";
  if (withUi) {
    uiDir = fs.mkdtempSync(path.join(os.tmpdir(), "aq-ui-"));
    fs.writeFileSync(path.join(uiDir, "index.html"), "<!doctype html><title>ui</title>");
    fs.writeFileSync(path.join(uiDir, "app.js"), "//js");
    fs.writeFileSync(path.join(uiDir, "serve.ps1"), "secret");
    fs.writeFileSync(path.join(uiDir, "README.md"), "docs");
    for (const f of [
      "package.json",
      "package-lock.json",
      "eslint.config.mjs",
      "eslint.config.js",
      ".npmrc",
      "notes.txt"
    ])
      fs.writeFileSync(path.join(uiDir, f), "{}");
    for (const d of ["css", "js", "vendor", "screenshots"]) fs.mkdirSync(path.join(uiDir, d));
    fs.writeFileSync(path.join(uiDir, "css", "styles.css"), "body{}");
    fs.writeFileSync(path.join(uiDir, "js", "app.js"), "//js");
    fs.writeFileSync(path.join(uiDir, "vendor", "chart.umd.min.js"), "//chart");
    fs.writeFileSync(path.join(uiDir, "screenshots", "desktop.png"), "png");
    fs.mkdirSync(path.join(uiDir, "_landing-backup"));
    fs.writeFileSync(path.join(uiDir, "_landing-backup", "index.html"), "old");
  }
  const config = loadConfig(
    {},
    {
      dbFile: ":memory:",
      log: false,
      uiDir,
      devLogDir: "",
      runDir: "",
      pyUrl: py ? py.url : "http://127.0.0.1:9",
      keySecret: TEST_KEY_SECRET,
      keySecretFile: "",
      notes: { pollMinMs: 0, verifyMs: 0, pyTimeoutMs: 2000, importTimeoutMs: 2000 },
      rate: { general: { max: 100000, windowMs: 60000 }, heavy: { max: 100000, windowMs: 60000 } },
      ...overrides
    }
  );
  const app = createApp(config, { authenticate, clock, fetchImpl, googleFetch });
  const server = http.createServer(app);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  async function call(method, p, body, headers = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined
    });
    const txt = await res.text();
    let json = null;
    try {
      json = JSON.parse(txt);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text: txt, headers: res.headers };
  }
  return {
    base,
    app,
    db: app.locals.db,
    repo: app.locals.repo,
    config,
    call,
    get: (p, h) => call("GET", p, undefined, h),
    post: (p, b, h) => call("POST", p, b, h),
    put: (p, b, h) => call("PUT", p, b, h),
    patch: (p, b, h) => call("PATCH", p, b, h),
    del: (p, h) => call("DELETE", p, undefined, h),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => {
          try {
            app.locals.db.close();
          } catch {
            /* closed */
          }
          if (uiDir) fs.rmSync(uiDir, { recursive: true, force: true });
          r();
        });
      })
  };
}

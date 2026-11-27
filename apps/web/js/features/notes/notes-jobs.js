/* =====================================================================================================
   notes-jobs.js - "Get notes" jobs: start, poll and remember them (AQ.notesJobs)

   What this file does:
     Starts a notes job for a video through the API, polls its progress and remembers which videos
     have finished notes. It is the single source of truth for notes state: the notes button, the
     notes panel and the video rows all read `status(videoId)` and listen with `subscribe(fn)`.

   Depends on:
     AQ.util (ID_RE) and AQ.api (base, available(), ready(), flush()). Loaded after api.js and before
     note-button.js and notes-view.js.

   How it talks to the server:
     Only through the API's /api/v1/notes/* endpoints (apps/api), which hand the work to the worker.
     The server keeps one job per video and caches finished notes, so a video that is already "ready"
     comes back at once. Without a reachable API every job fails with OFFLINE_MSG.
     While a job runs, `pages` counts the notebook pages already written; draftUrl(videoId) points at
     that live preview (/api/v1/notes/<id>/draft, visible only to the signed-in owner of the job).

   AI keys:
     start() and retry() first ask features/ai/ai-keys.js (AQ.aiKeys.requireKey("notes", ...)): when the
     notes AI needs a key the user has not connected, the user is pointed to Settings first. A 409
     {code:"ai_key_required"} from the server is handled the same way.

   Storage:
     {videoId: {jobId, state}} is kept in localStorage (`aq.notes.v1`) so queued and running jobs resume
     polling after a reload and ready ones are re-checked lazily (the server may have dropped them).
     At most MAX_RUNNING jobs run at once (the server's limit); extra videos wait here until a slot frees.

   Read next:
     `start()` in section 3, then `postJobServer()` and `poll()`. note-button.js draws the state.
   ===================================================================================================== */
(function () {
  "use strict";
  var u = AQ.util;

  var KEY = "aq.notes.v1";
  var JOB_RE = /^[a-f0-9]{32}$/;
  var MAX_RUNNING = 2;
  var POLL_MS = 1500;
  var BUSY_RETRY_MS = 6000;
  var STALE_MS = 40 * 60 * 1000;
  var OFFLINE_MSG = "AQspace server is not running. Start it with: docker compose up";
  var EXPIRED_MSG = "Notes expired — generate again";

  var entries = {}; // videoId -> {state, pct, stage, message, jobId, error, startedAt, needsCheck, polling, fails, video}
  var waiting = []; // video ids waiting for a free slot (no server job yet)
  var listeners = [];
  var posting = 0; // POSTs in flight
  var tickTimer = null;

  /* True once the API answered its health probe. Notes need the server: there is no offline mode. */
  function serverMode() {
    return !!(AQ.api && AQ.api.available && AQ.api.available());
  }
  function nurl(id) {
    return AQ.api.base + "/api/v1/notes/" + id;
  }
  function readJson(res) {
    return res
      .json()
      .catch(function () {
        return {};
      })
      .then(function (data) {
        return { res: res, data: data };
      });
  }

  // ===== 1. persistence =====
  // Only ready / queued / running entries are saved; errors are per session. Every storage call is wrapped
  // in try/catch because localStorage throws in private mode or when it is full, and the app must keep working.
  function save() {
    try {
      var out = {};
      Object.keys(entries).forEach(function (id) {
        var e = entries[id];
        if (e.state === "ready" || e.state === "queued" || e.state === "running")
          out[id] = { jobId: e.jobId || null, state: e.state };
      });
      AQ.storage.set(KEY, JSON.stringify(out));
    } catch {
      /* storage blocked: keep working in memory */
    }
  }
  function make(state, jobId) {
    return {
      state: state,
      pct: state === "ready" ? 100 : 0,
      stage: "",
      message: "",
      jobId: jobId || null,
      error: "",
      pages: 0,
      startedAt: Date.now(),
      needsCheck: false,
      polling: false,
      fails: 0,
      video: null
    };
  }
  function load() {
    var o = {};
    try {
      o = JSON.parse(AQ.storage.get(KEY) || "{}") || {};
    } catch {
      o = {};
    }
    Object.keys(o).forEach(function (id) {
      var r = o[id];
      if (!u.ID_RE.test(id) || !r || typeof r !== "object") return;
      var jobId = JOB_RE.test(String(r.jobId || "")) ? r.jobId : null;
      if (r.state === "ready" && jobId) {
        var e = make("ready", jobId);
        e.needsCheck = true;
        entries[id] = e;
      } else if (r.state === "queued" || r.state === "running") {
        if (jobId) {
          entries[id] = make("running", jobId);
          entries[id].message = "Resuming…";
        } else {
          entries[id] = make("queued");
          entries[id].message = "Waiting for a free slot…";
          waiting.push(id);
        }
      }
    });
  }

  // ===== 2. public reads =====
  function snapshot(id) {
    var e = entries[id];
    if (!e) return { state: "none", pct: 0, stage: "", message: "", jobId: null, error: "", pages: 0 };
    return {
      state: e.state,
      pct: Math.max(0, Math.min(100, Math.round(e.pct || 0))),
      stage: e.stage || "",
      message: e.message || "",
      jobId: e.jobId,
      error: e.error || "",
      pages: e.state === "running" ? e.pages || 0 : 0
    };
  }
  /**
   * Current notes state of a video. A "ready" entry restored from localStorage is re-checked with
   * the server the first time it is read.
   * @param {string} id YouTube video id.
   * @returns {{state: string, pct: number, stage: string, message: string, jobId: (string|null), error: string,
   *   pages: number}} state is one of "none", "queued", "running", "ready", "error"; pct is 0-100; pages counts
   *   the notebook pages already readable in the live preview (only while running).
   */
  function status(id) {
    var e = entries[id];
    if (e && e.needsCheck) {
      e.needsCheck = false;
      validate(id);
    }
    return snapshot(id);
  }
  /**
   * Links to the finished notes of a video.
   * @param {string} id YouTube video id.
   * @returns {{html: string, pdf: string}|null} API URLs, or null unless the notes are ready and the API is reachable.
   */
  function urls(id) {
    var e = entries[id];
    if (!e || e.state !== "ready" || !e.jobId) return null;
    if (!serverMode()) return null;
    return { html: nurl(id) + "/html", pdf: nurl(id) + "/pdf" };
  }
  /**
   * Live preview of a running job: the pages finished so far.
   * @param {string} id YouTube video id.
   * @returns {string|null} The API URL, or null unless the job is running and at least one page is ready.
   */
  function draftUrl(id) {
    var e = entries[id];
    if (!e || e.state !== "running" || !e.pages || !e.jobId || !serverMode()) return null;
    return nurl(id) + "/draft";
  }
  /* pages count from a server status: only ever grows */
  function takePages(e, n) {
    n = Math.round(Number(n));
    if (isFinite(n) && n > (e.pages || 0)) e.pages = Math.min(100, n);
  }
  /**
   * Listen for notes state changes of any video.
   * @param {function(string, object): void} fn Called with (videoId, status) after every change.
   * @returns {function(): void} Call it to stop listening.
   */
  function subscribe(fn) {
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }
  function changed(id) {
    save();
    var s = snapshot(id);
    listeners.slice().forEach(function (fn) {
      try {
        fn(id, s);
      } catch {
        /* a bad listener must not stop the others */
      }
    });
  }

  // ===== 3. starting =====
  function busyOrReady(id) {
    var e = entries[id];
    return !!(e && (e.state === "queued" || e.state === "running" || e.state === "ready"));
  }
  /**
   * Queue a notes job for a video. Does nothing while a job for it is queued, running or ready.
   * When the notes AI needs a key the user has not connected, ai-keys.js asks for it first.
   * @param {{id: string, title?: string}} video The video; the id must be a valid YouTube id.
   * @returns {void}
   */
  function start(video) {
    var id = video && video.id;
    if (!id || !u.ID_RE.test(id) || busyOrReady(id)) return;
    if (AQ.aiKeys && AQ.aiKeys.requireKey)
      AQ.aiKeys.requireKey("notes", function () {
        startNow(video);
      });
    else startNow(video);
  }
  /**
   * Forget the previous result (usually an error) and start the job again (same key check as start()).
   * @param {string} id YouTube video id.
   * @returns {void}
   */
  function retry(id) {
    if (AQ.aiKeys && AQ.aiKeys.requireKey)
      AQ.aiKeys.requireKey("notes", function () {
        retryNow(id);
      });
    else retryNow(id);
  }
  function startNow(video) {
    var id = video && video.id;
    if (!id || !u.ID_RE.test(id) || busyOrReady(id)) return; // no duplicates
    var e = (entries[id] = make("queued"));
    e.video = video;
    e.message = "Waiting for a free slot…";
    if (waiting.indexOf(id) < 0) waiting.push(id);
    changed(id);
    pump();
  }
  function retryNow(id) {
    var e = entries[id],
      video = (e && e.video) || { id: id };
    removeWaiting(id);
    delete entries[id];
    startNow(video);
  }
  function removeWaiting(id) {
    var i = waiting.indexOf(id);
    if (i >= 0) waiting.splice(i, 1);
  }

  function serverActive() {
    var n = posting;
    Object.keys(entries).forEach(function (id) {
      var e = entries[id];
      if (e.jobId && (e.state === "queued" || e.state === "running")) n++;
    });
    return n;
  }
  var apiSettled = true; // false until api.js has found (or failed to find) the API (see the end of this file)
  function pump() {
    if (!apiSettled) return;
    while (waiting.length && serverActive() < MAX_RUNNING) postJob(waiting.shift());
    if (waiting.length) ensureTick();
  }

  function postJob(id) {
    var e = entries[id];
    if (!e || e.state !== "queued") return;
    if (serverMode()) postJobServer(id, e);
    else fail(id, OFFLINE_MSG);
  }

  /* a status object from /api/v1/notes/<id> -> the entry (ready / error / running); true when the entry is still in progress */
  function applyServerStatus(id, e, d) {
    if (d.state === "ready") {
      e.state = "ready";
      e.pct = 100;
      e.stage = "pdf";
      e.message = "Notes ready";
      e.error = "";
      e.jobId = JOB_RE.test(String(d.jobId || "")) ? d.jobId : e.jobId || "server";
      changed(id);
      pump();
      return false;
    }
    if (d.state === "error") {
      fail(id, String(d.error || "The notes engine reported an error.").slice(0, 300));
      return false;
    }
    if (d.state === "none") {
      expire(id, String(d.message || EXPIRED_MSG).slice(0, 160));
      return false;
    }
    var pct = Number(d.pct);
    e.state = d.state === "running" ? "running" : "queued";
    e.jobId = JOB_RE.test(String(d.jobId || "")) ? d.jobId : e.jobId || "server";
    if (isFinite(pct) && pct >= (e.pct || 0)) e.pct = Math.min(100, pct);
    e.stage = String(d.stage || "").slice(0, 20);
    e.message = String(d.message || "").slice(0, 160);
    takePages(e, d.pages);
    changed(id);
    return true;
  }
  function postJobServer(id, e) {
    posting++;
    e.message = "Sending to the notes server…";
    changed(id);
    AQ.api
      .flush()
      .then(function () {
        // the video must already be in the user's playlists on the server
        return fetch(nurl(id), { method: "POST", cache: "no-store" });
      })
      .then(readJson)
      .then(function (o) {
        posting--;
        if (entries[id] !== e) return;
        if (o.res.status === 429) {
          // server busy / rate limited: try again shortly
          e.message = "Waiting for a free slot…";
          waiting.push(id);
          changed(id);
          setTimeout(pump, BUSY_RETRY_MS);
          return;
        }
        if (!o.res.ok) {
          fail(id, String(o.data.error || "The server answered with status " + o.res.status + ".").slice(0, 300));
          // 409 ai_key_required: point the user to Settings; once a key is saved the job starts again
          if (o.res.status === 409 && AQ.aiKeys && AQ.aiKeys.handleError)
            AQ.aiKeys.handleError(o.data, function () {
              retryNow(id);
            });
          return;
        }
        e.startedAt = Date.now();
        if (applyServerStatus(id, e, o.data)) {
          poll(id);
          ensureTick();
        }
      })
      .catch(function () {
        posting--;
        if (entries[id] === e) fail(id, OFFLINE_MSG);
      });
  }
  /* server mode: pick up notes that are already queued / running / ready on the server (made earlier or by another browser) */
  function hydrateFromServer() {
    return fetch(AQ.api.base + "/api/v1/notes", { cache: "no-store" })
      .then(readJson)
      .then(function (o) {
        if (!o.res.ok || !Array.isArray(o.data.notes)) return;
        o.data.notes.forEach(function (d) {
          var id = d.videoId;
          if (
            !u.ID_RE.test(id) ||
            (entries[id] &&
              (entries[id].state === "queued" || entries[id].state === "running" || entries[id].state === "ready") &&
              entries[id].jobId)
          )
            return;
          var e = make(
            d.state === "ready" ? "ready" : "running",
            JOB_RE.test(String(d.jobId || "")) ? d.jobId : "server"
          );
          e.pct = d.state === "ready" ? 100 : Math.max(0, Math.min(100, Number(d.pct) || 0));
          e.message = d.state === "ready" ? "Notes ready" : String(d.message || "").slice(0, 160);
          if (d.state !== "ready") takePages(e, d.pages);
          if (d.state === "ready") e.needsCheck = true;
          entries[id] = e;
          removeWaiting(id);
          changed(id);
          if (d.state !== "ready") poll(id);
        });
        ensureTick();
      });
  }
  function pollServer(id, e) {
    var jobId = e.jobId;
    fetch(nurl(id), { cache: "no-store" })
      .then(readJson)
      .then(function (o) {
        e.polling = false;
        if (entries[id] !== e || e.jobId !== jobId) return;
        e.fails = 0;
        if (!o.res.ok) {
          fail(id, String(o.data.error || "The server reported a problem.").slice(0, 300));
          return;
        }
        applyServerStatus(id, e, o.data);
      })
      .catch(function () {
        e.polling = false;
        if (entries[id] !== e) return;
        if (++e.fails >= 3) fail(id, OFFLINE_MSG);
      });
  }

  function fail(id, msg) {
    var e = entries[id];
    if (!e) return;
    removeWaiting(id);
    e.state = "error";
    e.error = msg;
    e.message = msg;
    e.jobId = null;
    e.polling = false;
    changed(id);
    pump();
  }

  // ===== 4. polling =====
  function ensureTick() {
    if (!tickTimer) tickTimer = setTimeout(tick, POLL_MS);
  }
  function tick() {
    tickTimer = null;
    var again = waiting.length > 0;
    Object.keys(entries).forEach(function (id) {
      var e = entries[id];
      if (e.jobId && (e.state === "queued" || e.state === "running")) {
        again = true;
        if (!e.polling) poll(id);
      }
    });
    if (waiting.length) pump();
    if (again) ensureTick();
  }

  function poll(id) {
    var e = entries[id];
    if (!e || !e.jobId || e.polling) return;
    if (Date.now() - e.startedAt > STALE_MS) {
      fail(id, "This is taking too long. Please try again.");
      return;
    }
    e.polling = true;
    if (serverMode()) pollServer(id, e);
    else {
      e.polling = false;
      fail(id, OFFLINE_MSG);
    }
  }

  function expire(id, msg) {
    var e = entries[id];
    if (!e) return;
    delete entries[id];
    removeWaiting(id);
    save();
    var n = make("none");
    n.message = msg;
    entries[id] = n; // keeps the message for the tooltip; "none" is never persisted
    changed(id);
    pump();
  }

  /* a ready job from an earlier session: make sure the server still has it (404 -> expired) */
  function validate(id) {
    var e = entries[id];
    if (!e || !e.jobId) return;
    if (!serverMode()) return; // server down: keep it, the links work again once it is back
    fetch(nurl(id), { cache: "no-store" })
      .then(readJson)
      .then(function (o) {
        if (entries[id] === e && o.res.ok && o.data.state === "none") expire(id, EXPIRED_MSG);
      })
      .catch(function () {
        /* server down: keep it */
      });
  }

  load();
  AQ.notesJobs = { status: status, start: start, subscribe: subscribe, urls: urls, draftUrl: draftUrl, retry: retry };

  // resume anything that was in flight when the page was closed
  function resume() {
    Object.keys(entries).forEach(function (id) {
      if (entries[id].state === "running") poll(id);
    });
    if (
      waiting.length ||
      Object.keys(entries).some(function (id) {
        return entries[id].state === "running";
      })
    ) {
      pump();
      ensureTick();
    }
  }
  if (!AQ.api || !AQ.api.ready) {
    resume();
  } else {
    // wait until we know whether the API is there (it answers in well under a second on localhost, 1.5 s at most per probe)
    apiSettled = false;
    AQ.api.ready().then(function () {
      apiSettled = true;
      if (!serverMode()) {
        resume();
        return;
      }
      // the server is the source of truth for jobs: forget job ids kept in localStorage that it did not hand out
      Object.keys(entries).forEach(function (id) {
        var e = entries[id];
        if (e.jobId && !e.video) {
          delete entries[id];
          changed(id);
        }
      });
      hydrateFromServer()
        .catch(function () {
          /* the buttons simply start from "Get notes" */
        })
        .then(function () {
          pump();
          ensureTick();
        });
    });
  }
})();

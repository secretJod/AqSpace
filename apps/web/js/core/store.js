/* =====================================================================================================
   store.js - the data store (AQ.store)

   What this file does:
     Holds all playlists, their videos and the watch progress of each video. It saves everything in
     browser storage (AQ.storage, one namespace per signed-in account) and tells the screens when something changed. No DOM code here.

   How it fits:
     Loaded by boot.js right after util.js (needs AQ.util and AQ.storage), once the account is known. Screens READ with `AQ.store.all()` / `get(id)` and WRITE
     with `create`, `addVideo`, `moveVideo`, ... Every write calls `changed()`, which saves and then calls
     the functions registered with `AQ.store.subscribe(fn)` (app.js re-renders the screen there).
     Every write is also passed to api.js (`remote(...)`) so the server gets a copy.

   Data model (localStorage key `aq.playlists.v1`, JSON array):
     Playlist = { id, name, description, created, updated, videos: [Video],
                  source?: { type:"youtube", listId, url, importedAt } }
     Video    = { id (11-char YouTube id), title, channel, duration ("m:ss" | "h:mm:ss" | ""), added }
     Dates are ISO strings. Playlist ids are slugs matching PLAYLIST_ID_RE (used in the #/playlist/<id> route).

   Storage:
     localStorage is the offline cache, so the app works with no server at all. Everything read from it
     (or from the server) is sanitised first, because another tab, an extension or an older build may
     have written it. If localStorage is unavailable or a write fails, the app keeps working in memory
     and AQ.store.storageOk() turns false (app.js then shows a warning banner).

   Start reading at:
     `load()` and the "playlist CRUD" section. Next file: core/api.js (server sync).
   ===================================================================================================== */
(function () {
  "use strict";

  var KEY = "aq.playlists.v1";
  var PLAYLIST_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
  var LIMITS = { name: 60, description: 160, title: 150, channel: 80 };
  var ID_RE = AQ.util.ID_RE;

  var playlists = [];
  var storageOk = true;
  var listeners = [];

  /* Write-through to the API (api.js, loaded after this file); a no-op when it is absent or unreachable. */
  function remote(name) {
    var A = window.AQ && AQ.api;
    if (A && A.record) {
      try {
        A.record(name, Array.prototype.slice.call(arguments, 1));
      } catch {
        /* the local copy is already saved */
      }
    }
  }

  // ===== 1. seed (first run only: when the key is absent) =====
  function seedData() {
    var now = new Date().toISOString();
    function v(id, title, channel, duration) {
      return { id: id, title: title, channel: channel, duration: duration, added: now };
    }
    function p(id, name, description, videos) {
      return { id: id, name: name, description: description, created: now, updated: now, videos: videos };
    }
    return [
      p("data-science", "Data Science", "Math and intuition behind modern data work.", [
        v("WUvTyaaNkzM", "The essence of calculus", "3Blue1Brown", "17:05"),
        v("aircAruvnKk", "But what is a neural network? | Deep learning chapter 1", "3Blue1Brown", "18:26")
      ]),
      p("ai-agents", "AI & Agents", "LLMs, agents and how they are built.", [
        v("IqQFaj3oO0Q", "What is Harness Engineering?", "Piyush Garg", "14:07"),
        v("zjkBMFhNj_g", "Intro to Large Language Models", "Andrej Karpathy", "59:48"),
        v("kCc8FmEb1nY", "Let's build GPT: from scratch, in code, spelled out.", "Andrej Karpathy", "1:56:20")
      ]),
      p("programming", "Programming", "", [
        v("rfscVS0vtbw", "Learn Python - Full Course for Beginners", "freeCodeCamp.org", "4:26:52")
      ])
    ];
  }

  // ===== 2. sanitising whatever comes out of storage =====
  function str(x, max) {
    return typeof x === "string" ? x.slice(0, max) : "";
  }
  function isoOr(x, fallback) {
    return typeof x === "string" && !isNaN(Date.parse(x)) ? x : fallback;
  }

  function cleanVideo(v) {
    if (!v || typeof v.id !== "string" || !ID_RE.test(v.id)) return null;
    var dur = AQ.util.normDuration(v.duration);
    return {
      id: v.id,
      title: str(v.title, LIMITS.title).trim() || "YouTube video " + v.id,
      channel: str(v.channel, LIMITS.channel).trim(),
      duration: dur,
      added: isoOr(v.added, new Date().toISOString())
    };
  }
  /* optional provenance of an imported playlist: { type:"youtube", listId, url, importedAt }.
     The url is rebuilt from the validated listId, so a tampered value can never become a link target. */
  var LIST_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
  function cleanSource(s) {
    if (
      !s ||
      typeof s !== "object" ||
      s.type !== "youtube" ||
      typeof s.listId !== "string" ||
      !LIST_ID_RE.test(s.listId)
    )
      return null;
    return {
      type: "youtube",
      listId: s.listId,
      url: "https://www.youtube.com/playlist?list=" + s.listId,
      importedAt: isoOr(s.importedAt, new Date().toISOString())
    };
  }
  function cleanPlaylists(arr) {
    if (!Array.isArray(arr)) return [];
    var seenIds = {},
      out = [];
    arr.forEach(function (p) {
      if (!p || typeof p.id !== "string" || !PLAYLIST_ID_RE.test(p.id) || seenIds[p.id]) return;
      var name = str(p.name, LIMITS.name).trim();
      if (!name) return;
      var seenVid = {},
        vids = [];
      (Array.isArray(p.videos) ? p.videos : []).forEach(function (raw) {
        var v = cleanVideo(raw);
        if (v && !seenVid[v.id]) {
          seenVid[v.id] = 1;
          vids.push(v);
        }
      });
      var now = new Date().toISOString();
      seenIds[p.id] = 1;
      var clean = {
        id: p.id,
        name: name,
        description: str(p.description, LIMITS.description).trim(),
        created: isoOr(p.created, now),
        updated: isoOr(p.updated, now),
        videos: vids
      };
      var src = cleanSource(p.source);
      if (src) clean.source = src;
      out.push(clean);
    });
    return out;
  }

  // ===== 3. persistence =====
  function load() {
    var raw = null;
    try {
      raw = AQ.storage.get(KEY);
    } catch {
      storageOk = false;
    }
    if (raw == null) {
      // key absent (or storage unreadable): first run -> seed
      playlists = seedData();
      if (storageOk) persist();
      return;
    }
    try {
      playlists = cleanPlaylists(JSON.parse(raw));
    } catch {
      playlists = [];
    }
  }
  function persist() {
    try {
      AQ.storage.set(KEY, JSON.stringify(playlists));
      storageOk = true;
      return true;
    } catch {
      storageOk = false;
      return false;
    }
  }
  // Called after every write: save, then tell every subscriber (app.js re-renders the screen).
  function changed() {
    persist();
    listeners.slice().forEach(function (fn) {
      try {
        fn();
      } catch {
        /* keep going */
      }
    });
  }

  // another tab changed the data: reload and tell the UI
  window.addEventListener("storage", function (e) {
    if (e.key !== AQ.storage.key(KEY)) return;
    try {
      playlists = e.newValue == null ? [] : cleanPlaylists(JSON.parse(e.newValue));
    } catch {
      return;
    }
    listeners.slice().forEach(function (fn) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    });
  });

  // ===== 4. queries =====
  /**
   * @returns {Array<object>} Every playlist, in display order. Treat it as read-only: change data through the
   *   write functions so the change is saved, synced and shown.
   */
  function all() {
    return playlists;
  }
  /**
   * @param {string} id Playlist id.
   * @returns {object|null} The playlist, or null when there is none with that id.
   */
  function get(id) {
    for (var i = 0; i < playlists.length; i++) if (playlists[i].id === id) return playlists[i];
    return null;
  }
  /**
   * Case-insensitive check for a playlist name already in use.
   * @param {string} name
   * @param {string} [exceptId] A playlist to ignore (the one being renamed).
   * @returns {boolean}
   */
  function nameTaken(name, exceptId) {
    var n = String(name).trim().toLowerCase();
    return playlists.some(function (p) {
      return p.id !== exceptId && p.name.toLowerCase() === n;
    });
  }
  /**
   * @param {object} p A playlist.
   * @param {string} vid A video id.
   * @returns {number} The video's index in the playlist, or -1.
   */
  function indexOfVideo(p, vid) {
    for (var i = 0; i < p.videos.length; i++) if (p.videos[i].id === vid) return i;
    return -1;
  }

  // ===== 5. playlist CRUD =====
  function newId(name) {
    var base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30) || "playlist";
    var id = base,
      n = 1;
    while (get(id)) {
      n++;
      id = base + "-" + n;
    }
    return id;
  }
  /**
   * Create an empty playlist.
   * @param {string} name Up to LIMITS.name characters, unique (case-insensitive).
   * @param {string} [description] Trimmed to LIMITS.description characters.
   * @returns {object|null} The new playlist, or null when the name is empty, too long or taken.
   */
  function create(name, description) {
    name = String(name || "").trim();
    if (!name || name.length > LIMITS.name || nameTaken(name)) return null;
    var now = new Date().toISOString();
    var p = {
      id: newId(name),
      name: name,
      description: String(description || "")
        .trim()
        .slice(0, LIMITS.description),
      created: now,
      updated: now,
      videos: []
    };
    playlists.push(p);
    changed();
    remote("create", p);
    return p;
  }
  /**
   * Create a playlist with all its videos in one write (used by the YouTube import).
   * Invalid and duplicate videos are skipped.
   * @param {string} name Up to LIMITS.name characters, unique (case-insensitive).
   * @param {string} [description]
   * @param {Array<object>} videos Raw video objects; each is cleaned like data from storage.
   * @param {{type: "youtube", listId: string}} [source] Recorded as playlist.source when valid.
   * @returns {{playlist: object, added: number, skipped: number}|null} null when the name is empty, too long or taken.
   */
  function createWithVideos(name, description, videos, source) {
    name = String(name || "").trim();
    if (!name || name.length > LIMITS.name || nameTaken(name)) return null;
    var now = new Date().toISOString(),
      seen = {},
      vids = [],
      skipped = 0;
    (Array.isArray(videos) ? videos : []).forEach(function (raw) {
      var v = cleanVideo(raw);
      if (!v || seen[v.id]) {
        skipped++;
        return;
      }
      seen[v.id] = 1;
      vids.push(v);
    });
    var p = {
      id: newId(name),
      name: name,
      description: String(description || "")
        .trim()
        .slice(0, LIMITS.description),
      created: now,
      updated: now,
      videos: vids
    };
    var src = cleanSource(source);
    if (src) p.source = src;
    playlists.push(p);
    changed();
    remote("create", p);
    return { playlist: p, added: vids.length, skipped: skipped };
  }
  /**
   * Rename a playlist and change its description.
   * @param {string} id
   * @param {string} name
   * @param {string} [description]
   * @returns {boolean} False when the playlist is unknown or the name is empty, too long or taken.
   */
  function update(id, name, description) {
    var p = get(id);
    name = String(name || "").trim();
    if (!p || !name || name.length > LIMITS.name || nameTaken(name, id)) return false;
    p.name = name;
    p.description = String(description || "")
      .trim()
      .slice(0, LIMITS.description);
    p.updated = new Date().toISOString();
    changed();
    remote("update", id, p.name, p.description);
    return true;
  }
  /**
   * Delete a playlist.
   * @param {string} id
   * @returns {boolean} False when there is no such playlist.
   */
  function remove(id) {
    var i = playlists.indexOf(get(id));
    if (i < 0) return false;
    playlists.splice(i, 1);
    changed();
    remote("remove", id);
    return true;
  }

  // ===== 6. videos =====
  function touch(p) {
    p.updated = new Date().toISOString();
  }
  /**
   * Add one video to a playlist.
   * @param {string} pid Playlist id.
   * @param {object} data Raw video ({id, title, channel, duration}); cleaned before it is stored.
   * @param {number} [atIndex] Insert position; appended when omitted.
   * @returns {object|null} The stored video, or null (invalid id, duplicate in this playlist, unknown playlist).
   */
  function addVideo(pid, data, atIndex) {
    var p = get(pid),
      v = cleanVideo(data);
    if (!p || !v || indexOfVideo(p, v.id) >= 0) return null;
    var i = typeof atIndex === "number" ? Math.max(0, Math.min(atIndex, p.videos.length)) : p.videos.length;
    p.videos.splice(i, 0, v);
    touch(p);
    changed();
    remote("addVideo", pid, v, i === p.videos.length - 1 ? undefined : i);
    return v;
  }
  /**
   * Remove a video from a playlist.
   * @param {string} pid Playlist id.
   * @param {string} vid Video id.
   * @returns {boolean} False when the playlist or video is unknown.
   */
  function removeVideo(pid, vid) {
    var p = get(pid);
    if (!p) return false;
    var i = indexOfVideo(p, vid);
    if (i < 0) return false;
    p.videos.splice(i, 1);
    touch(p);
    changed();
    remote("removeVideo", pid, vid);
    return true;
  }
  /**
   * Edit a video's title, channel or duration (fields left null keep their value).
   * @param {string} pid Playlist id.
   * @param {string} vid Video id.
   * @param {{title?: string, channel?: string, duration?: string}} patch
   * @returns {boolean} False when the playlist or video is unknown.
   */
  function updateVideo(pid, vid, patch) {
    var p = get(pid);
    if (!p) return false;
    var i = indexOfVideo(p, vid);
    if (i < 0) return false;
    var cur = p.videos[i];
    var next = cleanVideo({
      id: cur.id,
      title: patch.title != null ? patch.title : cur.title,
      channel: patch.channel != null ? patch.channel : cur.channel,
      duration: patch.duration != null ? patch.duration : cur.duration,
      added: cur.added
    });
    p.videos[i] = next;
    touch(p);
    changed();
    remote("updateVideo", pid, vid, next);
    return true;
  }
  /**
   * Move a video to another position in its playlist.
   * @param {string} pid Playlist id.
   * @param {number} from Current index.
   * @param {number} to New index.
   * @returns {boolean} False when nothing moved (unknown playlist, same or out-of-range index).
   */
  function moveVideo(pid, from, to) {
    var p = get(pid);
    if (!p) return false;
    if (from === to || from < 0 || to < 0 || from >= p.videos.length || to >= p.videos.length) return false;
    p.videos.splice(to, 0, p.videos.splice(from, 1)[0]);
    touch(p);
    changed();
    remote(
      "moveVideo",
      pid,
      p.videos.map(function (x) {
        return x.id;
      })
    );
    return true;
  }

  /**
   * Register a function called after every change (local writes, other tabs, server sync).
   * @param {function(): void} fn
   */
  function subscribe(fn) {
    listeners.push(fn);
  }

  /* ----- watch progress: the real playback position per video -----
     localStorage `aq.watch.v1` = { videoId: { pos, dur, done, updated } }   (seconds; done = >= 95% or ended)
     Memory is the source of truth and storage failures are swallowed, so playback never breaks because
     storage is full or blocked. Progress is time-based: watched seconds / total seconds.
     The legacy `aq.watched.v1` key (a list of ids that were merely opened) is deleted, not treated as finished. */
  var WATCH_KEY = "aq.watch.v1",
    OLD_WATCHED_KEY = "aq.watched.v1",
    DONE_AT = 0.95;
  var watch = {};

  function num(x) {
    x = +x;
    return isFinite(x) && x > 0 ? x : 0;
  }
  function cleanWatch(obj) {
    var out = {};
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
    Object.keys(obj).forEach(function (id) {
      var r = obj[id];
      if (!ID_RE.test(id) || !r || typeof r !== "object") return;
      var pos = num(r.pos);
      // "done" without any real position is a legacy "opened once" record, not a finished video
      out[id] = { pos: pos, dur: num(r.dur), done: !!r.done && pos >= 1, updated: num(r.updated) || Date.now() };
    });
    return out;
  }
  function persistWatch() {
    try {
      AQ.storage.set(WATCH_KEY, JSON.stringify(watch));
      return true;
    } catch {
      return false;
    }
  }
  (function loadWatch() {
    try {
      watch = cleanWatch(JSON.parse(AQ.storage.get(WATCH_KEY) || "{}"));
    } catch {
      watch = {};
    }
    // the legacy `aq.watched.v1` list only meant "opened once", not "finished": drop it instead of marking videos done
    try {
      AQ.storage.remove(OLD_WATCHED_KEY);
      persistWatch();
    } catch {
      /* storage unavailable */
    }
  })();

  window.addEventListener("storage", function (e) {
    if (e.key !== AQ.storage.key(WATCH_KEY)) return;
    try {
      watch = cleanWatch(JSON.parse(e.newValue || "{}"));
    } catch {
      return;
    }
    emit();
  });
  function emit() {
    listeners.slice().forEach(function (fn) {
      try {
        fn();
      } catch {
        /* keep going */
      }
    });
  }

  /** Listed duration (seconds) of a video id in any playlist, 0 if unknown. */
  function listedDur(id) {
    for (var i = 0; i < playlists.length; i++) {
      var k = indexOfVideo(playlists[i], id);
      if (k >= 0) {
        var s = AQ.util.parseDuration(playlists[i].videos[k].duration);
        if (s) return s;
      }
    }
    return 0;
  }
  /**
   * Format seconds as a clock: "4:05" or "1:02:03".
   * @param {number} sec
   * @returns {string}
   */
  function clock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600),
      m = Math.floor((sec % 3600) / 60),
      s = sec % 60;
    return h ? h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s : m + ":" + (s < 10 ? "0" : "") + s;
  }
  /**
   * Watch progress of one video.
   * @param {string} id Video id.
   * @param {number} [durHint] Duration in seconds to use when none was recorded; otherwise the listed duration is used.
   * @returns {{pos: number, dur: number, done: boolean, pct: number, state: "new"|"partial"|"done", updated: number}}
   *   `pct` is 0-100 and only reaches 100 when the video is finished.
   */
  function watchInfo(id, durHint) {
    var r = watch[id],
      dur = (r && r.dur) || num(durHint) || listedDur(id),
      pos = r ? r.pos : 0,
      done = !!(r && r.done);
    if (dur && pos > dur) pos = dur;
    var pct = done ? 100 : dur ? Math.min(99, Math.floor((100 * pos) / dur)) : 0;
    var state = done ? "done" : pos >= 1 ? "partial" : "new";
    return { pos: done ? dur || pos : pos, dur: dur, done: done, pct: pct, state: state, updated: r ? r.updated : 0 };
  }
  /**
   * Label for a video row's watch button: "Play", "Resume · 12:34" or "Replay".
   * @param {string} id Video id.
   * @returns {{label: string, icon: string, state: "new"|"partial"|"done", resumeAt: number}} resumeAt in seconds.
   */
  function watchLabel(id) {
    var w = watchInfo(id);
    if (w.state === "done") return { label: "Replay", icon: "play", state: "done", resumeAt: 0 };
    if (w.state === "partial")
      return { label: "Resume · " + clock(w.pos), icon: "play", state: "partial", resumeAt: Math.floor(w.pos) };
    return { label: "Play", icon: "play", state: "new", resumeAt: 0 };
  }
  /**
   * Save playback progress. A video counts as finished at 95% or when it ended; stopping part-way through a
   * replay makes it "partial" again. Saves silently (the player saves every few seconds, and re-rendering the
   * page each time would be wasteful); pass {notify: true} or call notify() to re-render.
   * @param {string} id Video id (validated; anything else is ignored).
   * @param {{pos?: number, dur?: number, done?: boolean, ended?: boolean}} patch Seconds.
   * @param {{notify?: boolean}} [opts]
   * @returns {object|null} The new watchInfo(id), or null for an invalid id or patch.
   */
  function watchSave(id, patch, opts) {
    if (typeof id !== "string" || !ID_RE.test(id) || !patch) return null;
    var r = watch[id] || (watch[id] = { pos: 0, dur: 0, done: false, updated: 0 });
    if (patch.dur != null && num(patch.dur) > 0) r.dur = num(patch.dur);
    if (patch.pos != null) r.pos = num(patch.pos);
    var dur = r.dur || listedDur(id);
    if (dur && r.pos > dur) r.pos = dur;
    if (patch.ended || patch.done || (dur && r.pos >= DONE_AT * dur && r.pos > 0)) {
      r.done = true;
      if (patch.ended && dur) r.pos = dur;
    } else if (r.done && patch.pos != null && r.pos >= 1 && dur && r.pos < DONE_AT * dur) {
      // re-watching a finished video (Replay) and stopping part-way: it becomes "Resume" again
      r.done = false;
    }
    r.updated = Date.now();
    persistWatch();
    remote("watch", id, r);
    if (opts && opts.notify) emit();
    return watchInfo(id);
  }
  /**
   * Record a video's real duration (reported by the player) and fill it in wherever the listing has none.
   * @param {string} id Video id.
   * @param {number} sec Duration in seconds.
   * @param {{notify?: boolean}} [opts] Silent unless notify is set.
   */
  function learnDuration(id, sec, opts) {
    sec = Math.round(num(sec));
    if (!sec || !ID_RE.test(id)) return;
    var r = watch[id] || (watch[id] = { pos: 0, dur: 0, done: false, updated: Date.now() });
    r.dur = sec;
    var touched = false;
    playlists.forEach(function (p) {
      var k = indexOfVideo(p, id);
      if (k >= 0 && !AQ.util.parseDuration(p.videos[k].duration)) {
        p.videos[k].duration = AQ.util.normDuration(clock(sec));
        touched = true;
        remote("updateVideo", p.id, id, p.videos[k]);
      }
    });
    persistWatch();
    remote("watch", id, r);
    if (touched) persist();
    if (opts && opts.notify) emit();
  }
  /**
   * @param {string} id Video id.
   * @returns {boolean} True when the video is finished.
   */
  function isWatched(id) {
    return !!(watch[id] && watch[id].done);
  }

  // Adds up the watch progress of a list of videos (each video id counted once).
  // Short names: w = watched seconds, t = total seconds, n = number of unique videos.
  // The percentage is time-based; it never shows 100% unless really finished, and never 0% once something was watched.
  function sumVideos(videos) {
    var seen = {},
      w = 0,
      t = 0,
      done = 0,
      n = 0,
      unknown = 0;
    videos.forEach(function (v) {
      if (seen[v.id]) return;
      seen[v.id] = 1;
      n++;
      var i = watchInfo(v.id, AQ.util.parseDuration(v.duration));
      if (i.done) done++;
      if (i.dur > 0) {
        t += i.dur;
        w += i.done ? i.dur : Math.min(i.pos, i.dur);
      } else unknown++;
    });
    var pct;
    if (t > 0) {
      pct = Math.round((100 * w) / t);
      if (pct >= 100 && w < t) pct = 99;
      if (pct < 1 && w > 0) pct = 1;
    } else pct = n ? Math.round((100 * done) / n) : 0; // no known durations at all: fall back to counting videos
    return { done: done, total: n, pct: pct, watchedSec: w, totalSec: t, unknown: unknown, timed: t > 0 };
  }
  /**
   * Time-based progress of a playlist.
   * @param {object} p A playlist.
   * @returns {{done: number, total: number, pct: number, watchedSec: number, totalSec: number, unknown: number,
   *            timed: boolean}} `done`/`total` count videos; `timed` is false when no duration is known (pct then counts videos).
   */
  function progress(p) {
    return sumVideos(p.videos);
  }
  /**
   * Progress across all playlists (each unique video counted once).
   * @returns {object} Same shape as progress().
   */
  function overall() {
    var all = [];
    playlists.forEach(function (p) {
      p.videos.forEach(function (v) {
        all.push(v);
      });
    });
    return sumVideos(all);
  }
  /**
   * Human text for a progress object: "14 of 36 min" or "1 hr 2 min of 4 hr 30 min".
   * @param {object} pr A result of progress() or overall().
   * @returns {string} "" when no duration is known.
   */
  function progressTime(pr) {
    var h = AQ.util.humanDuration;
    if (!pr.totalSec) return "";
    var wTxt = pr.watchedSec < 30 ? "0 min" : h(pr.watchedSec);
    if (pr.totalSec < 3600 && pr.watchedSec < 3600) return wTxt.replace(/ min$/, "") + " of " + h(pr.totalSec);
    return wTxt + " of " + h(pr.totalSec) + (pr.unknown ? "+" : "");
  }

  // ===== 7. sync with the API (called by api.js) =====
  /**
   * Everything the server needs for a full import.
   * @returns {{playlists: Array<object>, progress: object}}
   */
  function exportState() {
    return { playlists: playlists, progress: watch };
  }
  /**
   * Adopt the server's playlists and progress. They are sanitised like anything read from storage; for each
   * video the newer watch record (local or server) wins. Subscribers are told only when something changed.
   * @param {Array<object>} pls Playlists from the server.
   * @param {object} prog Watch records from the server, keyed by video id.
   */
  function applyRemote(pls, prog) {
    var np = cleanPlaylists(pls),
      nw = cleanWatch(prog);
    Object.keys(watch).forEach(function (id) {
      if (!nw[id] || watch[id].updated > nw[id].updated) nw[id] = watch[id];
    });
    var diff = JSON.stringify(np) !== JSON.stringify(playlists) || JSON.stringify(nw) !== JSON.stringify(watch);
    playlists = np;
    watch = nw;
    persist();
    persistWatch();
    if (diff) emit();
  }

  load();

  AQ.store = {
    exportState: exportState,
    applyRemote: applyRemote,
    LIMITS: LIMITS,
    all: all,
    get: get,
    nameTaken: nameTaken,
    indexOfVideo: indexOfVideo,
    create: create,
    createWithVideos: createWithVideos,
    update: update,
    remove: remove,
    addVideo: addVideo,
    removeVideo: removeVideo,
    updateVideo: updateVideo,
    moveVideo: moveVideo,
    isWatched: isWatched,
    progress: progress,
    overall: overall,
    progressTime: progressTime,
    watchInfo: watchInfo,
    watchLabel: watchLabel,
    watchSave: watchSave,
    learnDuration: learnDuration,
    clock: clock,
    /** Tell every subscriber to re-render (after silent watchSave() calls). */
    notify: function () {
      emit();
    },
    subscribe: subscribe,
    /** @returns {boolean} False while localStorage cannot be written (changes then live only in memory). */
    storageOk: function () {
      return storageOk;
    }
  };
})();

/* =====================================================================================================
   api.js - the connection to the API server (AQ.api)

   What this file does:
     Talks to the HTTP API (apps/api, under /api/v1). It loads playlists and watch progress from the
     server on start and sends every later change to the server, one after the other, in order.
     The UI keeps working without a server: browser storage (AQ.storage) stays the offline cache and
     every store function stays synchronous.

     When the API is reachable (the same origin when apps/api serves this page, otherwise
     http://127.0.0.1:5180 for a page opened another way) this file
       1. loads playlists and watch progress on start and hands them to the store, which re-renders,
       2. uploads what was in browser storage once, and only when there is something to upload: a new
          account with nothing saved in this browser sends nothing and simply loads the server's (empty) data,
       3. writes every later change through to the server in order (AQ.store calls AQ.api.record(...)),
       4. sets `aq.dirty.v1` in browser storage when a write cannot be sent; the next successful connection
          then pushes the whole local state, so offline edits are never lost.

     Accounts on a shared browser:
       Before it syncs, this file checks that the server still talks about the account whose storage this
       page uses (AQ.storage.matches). Local data is only ever uploaded to the account it was saved for: if
       someone else signed in meanwhile (in another tab, or while this page was offline), the page reloads
       into the new account's own, separate storage instead of uploading the previous person's edits.

   How it fits:
     Loaded by boot.js after store.js (needs AQ.store), once the account is known. boot.js has already
     found the server (AQ.boot.base) and asked who is signed in (AQ.boot.status). store.js calls
     `AQ.api.record(name, args)` after each local change. notes-jobs.js, import-playlist.js, smart-arrange.js and profile.js use `AQ.api.request(...)`
     and ask `AQ.api.available()` whether the server is there. A 401 {code:"auth_required"} stops all
     traffic once and calls AQ.profile.authRequired() (profile.js shows the sign-in screen).

   Public API:
     AQ.api.ready()      -> Promise<boolean>   resolves once the first probe + sync attempt finished
     AQ.api.available()  -> boolean            server reachable and in sync
     AQ.api.base         -> "" | "http://127.0.0.1:5180"
     AQ.api.request(method, path, body, opts) -> Promise<{status, json}>
     AQ.api.flush()      -> Promise            resolves when queued writes (and pending progress) were sent
     AQ.api.record(name, argsArray)            used by store.js only
     AQ.api.signedOut()  -> boolean            a call returned 401 auth_required

   Start reading at:
     `connect()` near the bottom, then `reconcile()`, then the `ops` table (store -> server).
     Next file: features/profile/profile.js (sign-in), or the API routes in apps/api/src/routes/.
   ===================================================================================================== */
(function () {
  "use strict";

  var DIRTY_KEY = "aq.dirty.v1"; // stored flag, per account: "there are local changes the server has not seen"
  var SYNCED_KEY = "aq.synced.v1"; // stored flag, per account: "this browser's copy has been in sync with the server"
  var WATCH_DELAY_MS = 2000;

  var api = { base: "" };
  var state = { ok: false, reconciled: false, earlyMut: false };
  var chain = Promise.resolve();
  var pending = {}; // videoId -> { timer, rec }
  var readyP = null;

  // ===== 1. tiny helpers =====
  function isDirty() {
    try {
      return AQ.storage.get(DIRTY_KEY) === "1";
    } catch {
      return false;
    }
  }
  function markDirty() {
    try {
      AQ.storage.set(DIRTY_KEY, "1");
    } catch {
      /* storage blocked */
    }
  }
  function clearDirty() {
    try {
      AQ.storage.remove(DIRTY_KEY);
    } catch {
      /* storage blocked */
    }
  }
  function wasSynced() {
    try {
      return AQ.storage.get(SYNCED_KEY) === "1";
    } catch {
      return false;
    }
  }
  function markSynced() {
    try {
      AQ.storage.set(SYNCED_KEY, "1");
    } catch {
      /* storage blocked */
    }
  }
  function hasLocalData(st) {
    return st.playlists.length > 0 || Object.keys(st.progress).length > 0;
  }
  function plain(x) {
    return JSON.parse(JSON.stringify(x));
  }

  /* ---------- signed-out handling: any 401 {code:"auth_required"} stops all traffic once and tells profile.js ---------- */
  var authLost = false;
  function authRequired() {
    if (authLost) return;
    authLost = true;
    state.ok = false;
    Object.keys(pending).forEach(function (id) {
      clearTimeout(pending[id].timer);
      delete pending[id];
    });
    if (window.AQ && AQ.profile && AQ.profile.authRequired) AQ.profile.authRequired();
  }
  var AUTH_401 = { status: 401, json: { code: "auth_required" } };

  // One fetch wrapper for every call: JSON in and out, no HTTP cache, and a timeout (15 s by default) so a
  // hung server never leaves the UI waiting forever.
  function req(method, path, body, opts) {
    opts = opts || {};
    if (authLost && !opts.authFree) return Promise.resolve(AUTH_401); // signed out: stop polling and writes
    var base = opts.base != null ? opts.base : api.base;
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctl) ctl.abort();
    }, opts.timeout || 15000);
    function done() {
      clearTimeout(timer);
    }
    return fetch(base + path, {
      method: method,
      cache: "no-store",
      keepalive: !!opts.keepalive,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl ? ctl.signal : undefined
    }).then(
      function (res) {
        if (res.status === 204) {
          done();
          return { status: 204, json: null };
        }
        return res
          .json()
          .catch(function () {
            return null;
          })
          .then(function (j) {
            done();
            if (res.status === 401 && !opts.authFree && j && j.code === "auth_required") authRequired();
            return { status: res.status, json: j };
          });
      },
      function (err) {
        done();
        throw err;
      }
    );
  }

  // ===== 2. finding the server and checking the account =====
  // On the first connection boot.js has already found the server; later attempts (after being offline) probe again.
  function detect(first) {
    if (first) return Promise.resolve(AQ.boot.base);
    return AQ.boot.findServer();
  }

  /* Privacy between accounts on a shared browser: the local copy (and its offline edits) belongs to the account
     this page started with. Before syncing, make sure the server's session is still that account. If it is not
     (someone signed out and another person signed in, in another tab or while this page was offline), never push
     this copy: reload, so the page opens with the signed-in account's own storage.
     Resolves true when it is safe to sync. */
  var switching = false;
  function sameAccount(first) {
    if (first && AQ.boot.status) return Promise.resolve(true); // boot.js picked the storage from this very answer
    return req("GET", "/api/v1/auth/status", undefined, { authFree: true, timeout: 5000 }).then(function (r) {
      if (r.status !== 200 || !r.json) throw new Error("status failed");
      if (AQ.storage.matches(r.json)) return true;
      if (!switching) {
        switching = true;
        state.ok = false;
        location.reload();
      }
      return false;
    });
  }

  // ===== 3. server -> store =====
  function pull() {
    return Promise.all([req("GET", "/api/v1/playlists?include=videos"), req("GET", "/api/v1/progress")]).then(
      function (rs) {
        if (rs[0].status !== 200 || rs[1].status !== 200) throw new Error("pull failed");
        AQ.store.applyRemote(rs[0].json.playlists, rs[1].json.progress);
      }
    );
  }

  /**
   * Decides between "adopt the server's data" and "push the local data", then applies the result.
   * The local copy is pushed only when it holds something the server has not seen:
   *   - offline edits (the dirty flag), or
   *   - data saved in this browser before it ever synced with this account (the server is not
   *     bootstrapped yet and this browser has never been in sync with it).
   * A new account with nothing saved locally uploads nothing; it just loads the server's data. The server
   * then stays "not bootstrapped" until there is real local data to import, and the synced flag stops a
   * cache of server data from being pushed back later (which could bring back playlists deleted elsewhere).
   */
  function reconcile() {
    return req("GET", "/api/v1/me")
      .then(function (me) {
        if (me.status !== 200 || !me.json) throw new Error("me failed");
        var boot = !!me.json.bootstrapped;
        var st = AQ.store.exportState();
        if (isDirty() || (!boot && !wasSynced() && hasLocalData(st))) {
          return req(
            "POST",
            "/api/v1/sync/import",
            { mode: boot ? "replace" : "merge", playlists: st.playlists, progress: st.progress },
            { timeout: 30000 }
          ).then(function (r) {
            if (r.status !== 200 || !r.json) throw new Error("import failed");
            return r.json;
          });
        }
        return Promise.all([req("GET", "/api/v1/playlists?include=videos"), req("GET", "/api/v1/progress")]).then(
          function (rs) {
            if (rs[0].status !== 200 || rs[1].status !== 200) throw new Error("load failed");
            return { playlists: rs[0].json.playlists, progress: rs[1].json.progress };
          }
        );
      })
      .then(function (data) {
        if (state.earlyMut) {
          state.earlyMut = false;
          markDirty();
          return reconcile();
        } // the user edited while we were loading: push theirs instead
        clearDirty();
        markSynced();
        AQ.store.applyRemote(data.playlists, data.progress);
        state.ok = true;
        state.reconciled = true;
      });
  }

  function connect(first) {
    return detect(first).then(function (base) {
      if (base === null) {
        state.reconciled = true;
        state.ok = false;
        return false;
      }
      api.base = base;
      return sameAccount(first)
        .then(function (same) {
          if (!same) throw new Error("account changed");
          return reconcile();
        })
        .then(
          function () {
            return true;
          },
          function () {
            state.reconciled = true;
            state.ok = false;
            return false;
          }
        );
    });
  }

  // ===== 4. store -> server (write-through, in order) =====
  function vid(v) {
    return { id: v.id, title: v.title, channel: v.channel, duration: v.duration, added: v.added };
  }
  var P = "/api/v1/playlists/";
  var ops = {
    create: function (a) {
      var p = a[0];
      return req("POST", "/api/v1/playlists", {
        id: p.id,
        name: p.name,
        description: p.description,
        source: p.source,
        videos: p.videos.map(vid)
      });
    },
    update: function (a) {
      return req("PATCH", P + a[0], { name: a[1], description: a[2] });
    },
    remove: function (a) {
      return req("DELETE", P + a[0]);
    },
    addVideo: function (a) {
      var body = vid(a[1]);
      if (typeof a[2] === "number") body.position = a[2];
      return req("POST", P + a[0] + "/videos", body);
    },
    removeVideo: function (a) {
      return req("DELETE", P + a[0] + "/videos/" + a[1]);
    },
    updateVideo: function (a) {
      return req("PATCH", P + a[0] + "/videos/" + a[1], {
        title: a[2].title,
        channel: a[2].channel,
        duration: a[2].duration
      });
    },
    moveVideo: function (a) {
      return req("PUT", P + a[0] + "/videos/order", { order: a[1] });
    },
    watch: function (a) {
      var r = a[1];
      return req(
        "PUT",
        "/api/v1/progress/" + a[0],
        { pos: r.pos, dur: r.dur, done: !!r.done, updated: r.updated },
        { keepalive: true }
      );
    }
  };

  function exec(op) {
    if (!state.ok) {
      markDirty();
      return Promise.resolve();
    }
    if (isDirty()) return Promise.resolve(); // local state will be pushed as a whole on the next sync
    return ops[op.name](op.a).then(
      function (r) {
        if (r.status >= 500) throw new Error("server error");
        var gone = r.status === 404 && (op.name === "remove" || op.name === "removeVideo");
        if (r.status >= 400 && !gone && op.name !== "watch")
          return pull().catch(function () {
            /* next start fixes it */
          }); // server refused: take its view
      },
      function () {
        state.ok = false;
        markDirty(); // unreachable: remember to push everything later
      }
    );
  }
  // `chain` is one long promise: each write waits for the previous one, so the server sees changes in order.
  function enqueue(op) {
    chain = chain
      .then(function () {
        return exec(op);
      })
      .catch(function () {
        /* never break the chain */
      });
  }

  function flushWatch() {
    Object.keys(pending).forEach(function (id) {
      var p = pending[id];
      delete pending[id];
      clearTimeout(p.timer);
      enqueue({ name: "watch", a: [id, p.rec] });
    });
  }
  // Watch progress changes every few seconds while a video plays, so we wait WATCH_DELAY_MS and send only the latest value.
  function queueWatch(id, rec) {
    if (!state.reconciled) {
      state.earlyMut = true;
      markDirty();
      return;
    }
    if (!state.ok) {
      markDirty();
      return;
    }
    var p = pending[id];
    if (p) {
      p.rec = rec;
      return;
    }
    pending[id] = {
      rec: rec,
      timer: setTimeout(function () {
        var q = pending[id];
        delete pending[id];
        if (q) enqueue({ name: "watch", a: [id, q.rec] });
      }, WATCH_DELAY_MS)
    };
  }

  /**
   * Send a store change to the server (called by store.js after each local write). Changes made before the
   * first sync finished, or while the server is unreachable, mark the local state dirty instead; it is then
   * pushed as a whole on the next connection.
   * @param {string} name A key of `ops` ("create", "addVideo", "watch", ...); unknown names are ignored.
   * @param {Array} args The store function's arguments (copied, so later edits do not leak into the queue).
   */
  api.record = function (name, args) {
    if (!ops[name]) return;
    var a = plain(args);
    if (name === "watch") {
      queueWatch(a[0], a[1]);
      return;
    }
    if (!state.reconciled) {
      state.earlyMut = true;
      markDirty();
      return;
    } // still loading: the whole local state gets pushed
    enqueue({ name: name, a: a });
  };
  /**
   * Send pending watch progress now and wait for every queued write.
   * @returns {Promise<void>} Resolves when the queue is drained (it never rejects).
   */
  api.flush = function () {
    flushWatch();
    return chain.then(function () {
      /* drained */
    });
  };
  /**
   * @returns {boolean} True when the server is reachable and in sync with this browser.
   */
  api.available = function () {
    return state.ok;
  };
  /**
   * JSON request against the API for other modules (notes, import, smart arrange, profile).
   * After a 401 auth_required every call short-circuits to that 401, unless opts.authFree is set (for /auth/*).
   * @param {string} method HTTP method.
   * @param {string} path Path starting with /api/v1/.
   * @param {*} [body] Sent as JSON when defined.
   * @param {{timeout?: number, authFree?: boolean, keepalive?: boolean, base?: string}} [opts] timeout in ms.
   * @returns {Promise<{status: number, json: *}>} Rejects on network failure or timeout.
   */
  api.request = function (method, path, body, opts) {
    return req(method, path, body, opts);
  };
  /**
   * @returns {boolean} True once a call returned 401 auth_required (all requests then short-circuit).
   */
  api.signedOut = function () {
    return authLost;
  };
  /**
   * @returns {Promise<boolean>} Resolves once the first probe and sync attempt finished: true when connected.
   */
  api.ready = function () {
    return readyP || Promise.resolve(false);
  };

  /* try again when the browser comes back online / the tab is shown and the last attempt failed */
  function retry() {
    if (authLost) return;
    if (state.ok || !state.reconciled || (readyP && state.connecting)) return;
    state.connecting = true;
    readyP = connect(false).then(function (ok) {
      state.connecting = false;
      return ok;
    });
  }
  /* With Google sign-in, another tab may have signed out and signed someone else in while this tab was hidden.
     The session cookie is shared by all tabs, so this tab's next write would land in that other account.
     Check when the tab is shown again; sameAccount() reloads into the right account if it changed. */
  function recheckAccount() {
    if (authLost || !state.ok || !AQ.boot.status || AQ.boot.status.authMode !== "google") return;
    sameAccount(false).catch(function () {
      /* server busy or offline: the next sync checks again */
    });
  }
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushWatch();
    else {
      recheckAccount();
      retry();
    }
  });
  window.addEventListener("pagehide", flushWatch);

  readyP = connect(true);
  window.AQ = window.AQ || {};
  AQ.api = api;
})();

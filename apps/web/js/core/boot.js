/* =====================================================================================================
   boot.js - start-up: find the API, learn who is signed in, then load the app (AQ.boot)

   What this file does:
     1. hides the app (<html class="auth-pending">) so nothing shows before we know who is signed in,
     2. finds the API server (the same origin when apps/api serves this page, otherwise
        http://127.0.0.1:5180 for a page opened another way),
     3. asks it who is signed in (GET /api/v1/auth/status) and hands the answer to AQ.storage, which picks
        that account's storage namespace,
     4. only then loads every other app script, in the order listed in APP_SCRIPTS below.

   Why the app is loaded this late:
     Most features read their saved data from localStorage the moment their file runs. If they ran before
     the account was known, a browser shared by several Google accounts could show, or sync, the previous
     person's data. Loading them after step 3 makes that impossible by construction.

   How it fits:
     index.html loads only core/storage.js and this file. Later files may use AQ.boot.base, AQ.boot.status
     (api.js and profile.js do, so the server is probed and asked only once) and AQ.boot.findServer()
     (api.js uses it to look for the server again after it was unreachable).

   Public API:
     AQ.boot.base          -> "" | "http://127.0.0.1:5180" | null   where the API was found (null = not found)
     AQ.boot.status        -> object | null   the /auth/status reply used to pick the storage namespace
     AQ.boot.findServer()  -> Promise<string|null>   probe for the API again

   Start reading at:
     `start()` at the bottom. Next file: core/demo-cleanup.js, the first app script.
   ===================================================================================================== */
window.AQ = window.AQ || {};
(function () {
  "use strict";

  document.documentElement.classList.add("auth-pending"); // profile.js removes it once a screen is chosen

  var FALLBACK = "http://127.0.0.1:5180"; // the API's default local address, for a page not served by it

  /* The app's scripts, loaded in this order once the account is known. These are classic scripts: each adds
     one piece to the global `AQ` object, and while it loads it may only use pieces from files listed above
     it. See README.md, "Load order". */
  var APP_SCRIPTS = [
    // 1. Core: no screens, only data and helpers. demo-cleanup.js runs first because store.js and the
    //    dashboard files read storage as they load. profile.js comes right after api.js: it chooses
    //    between the app and the sign-in screen.
    "js/core/demo-cleanup.js",
    "js/core/util.js",
    "js/core/store.js",
    "js/core/api.js",
    "js/features/profile/profile.js",

    // 2. Shared widgets and the playlist features (notes, player, split view, import, smart arrange)
    "js/ui/dialog.js",
    "js/features/ai/ai-keys.js", // AI keys: the Settings prompt + requireKey gate used by notes and Smart arrange below
    "js/features/notes/notes-jobs.js",
    "js/features/notes/note-button.js",
    "js/features/notes/notes-view.js",
    "js/features/player/player.js",
    "js/ui/water-button.js",
    "js/ui/click-spark.js",
    "js/features/smart/smart-magic.js",
    "js/features/playlists/split-view.js",
    "js/features/playlists/import-playlist.js",
    "js/features/smart/smart-arrange.js",

    // 3. Dashboard effects and the card-to-panel expand, then streak, achievements and the bottom navbar.
    //    achievements.js must follow streak.js (it reads AQ.streak) and neural.js (it wraps AQ.neural.mount).
    "js/features/dashboard/motion.js",
    "js/features/dashboard/neural.js",
    "js/features/dashboard/hud.js",
    "js/features/dashboard/expand.js",
    "js/features/streak/streak.js",
    "js/features/achievements/achievements.js",
    "js/features/navbar/navbar.js",

    // 4. Dashboard: the vendored Chart.js first (the CSP forbids CDNs), then the activity data and its hooks,
    //    goals, chart helpers, HUD metrics and widgets, the sticky board and finally the dashboard screen.
    "js/vendor/chart.umd.js",
    "js/features/dashboard/activity-log.js",
    "js/features/dashboard/activity-hooks.js",
    "js/features/dashboard/goals.js",
    "js/features/dashboard/charts.js",
    "js/features/dashboard/hud-metrics.js",
    "js/features/dashboard/hud-gauges.js",
    "js/features/dashboard/sticky-board.js",
    "js/features/dashboard/dashboard.js",
    "js/features/settings/settings-view.js", // the Settings page (#/settings): AI keys

    // 5. The app: router and screens. Loaded last because it uses everything above.
    "js/app.js"
  ];

  /** GET a JSON endpoint with a timeout. Resolves {status, json}; rejects on network failure or timeout. */
  function getJson(base, path, timeoutMs) {
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctl) ctl.abort();
    }, timeoutMs);
    return fetch(base + path, { cache: "no-store", signal: ctl ? ctl.signal : undefined })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return null;
          })
          .then(function (j) {
            return { status: res.status, json: j };
          });
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

  function probe(base) {
    return getJson(base, "/api/v1/health", 1500).then(
      function (r) {
        return r.status === 200 && !!r.json && r.json.service === "aq-api"; // the name apps/api reports
      },
      function () {
        return false;
      }
    );
  }

  /**
   * Look for the API: the page's own origin first, then the local fallback address.
   * @returns {Promise<string|null>} The base URL ("" for same origin), or null when no server answered.
   */
  function findServer() {
    var cands = [];
    if (/^https?:$/.test(location.protocol)) cands.push("");
    if (location.port !== "5180") cands.push(FALLBACK);
    return cands.reduce(function (p, base) {
      return p.then(function (found) {
        if (found !== null) return found;
        return probe(base).then(function (ok) {
          return ok ? base : null;
        });
      });
    }, Promise.resolve(null));
  }

  // One retry, so a single slow reply does not leave the page without its saved data (an unknown account
  // gets memory-only storage).
  function fetchStatus(base, triesLeft) {
    return getJson(base, "/api/v1/auth/status", 5000)
      .then(function (r) {
        if (r.status === 200 && r.json && typeof r.json === "object") return r.json;
        throw new Error("status " + r.status);
      })
      .catch(function () {
        return triesLeft > 0 ? fetchStatus(base, triesLeft - 1) : null;
      });
  }

  // async = false keeps execution in list order while the browser still downloads the files in parallel.
  function loadScripts() {
    APP_SCRIPTS.forEach(function (src) {
      var s = document.createElement("script");
      s.src = src;
      s.async = false;
      document.body.appendChild(s);
    });
  }

  var boot = { base: null, status: null, findServer: findServer };
  AQ.boot = boot;

  function start() {
    findServer()
      .then(function (base) {
        boot.base = base;
        return base === null ? null : fetchStatus(base, 1);
      })
      .catch(function () {
        return null;
      })
      .then(function (status) {
        boot.status = status;
        AQ.storage.useAccount(status, boot.base !== null);
        loadScripts();
      });
  }
  start();
})();

/* =====================================================================================================
   What this file does:
     Feeds the activity log (activity-log.js) from real usage without touching app.js, player.js or
     notes-jobs.js: it wraps `AQ.store.watchSave` (watch time from position deltas), listens to
     `AQ.notesJobs.subscribe` (notes finished) and wraps `AQ.store.create` / `createWithVideos`.

   How it fits:
     Loaded after store.js, notes-jobs.js and activity-log.js (any place after those works, before or
     after app.js). Everything is guarded: if a piece is missing the hook is simply skipped.

   Streak double counting (read this before changing STREAK_RECORDED_BY_APP_JS):
     app.js has its own "activity hooks for the streak" section that calls `AQ.streak.record(kind)`
     for watch / notes / playlist. `AQ.activity.log()` would call it too, so while that section exists we
     log with `{streak: false}`. Plan: the integrator deletes the app.js section and flips the constant to
     false; then the activity log is the single owner of the streak and also passes minutes to it.

   Start reading at:
     `hookWatch()` (section 2), the only non-trivial part.
   ===================================================================================================== */
window.AQ = window.AQ || {};
(function (AQ) {
  "use strict";

  var STREAK_RECORDED_BY_APP_JS = false; // see the header; set to false once app.js no longer records the streak
  var SITTING_GAP_MS = 3 * 60000; // no position update for 3 min = a new sitting (new session)
  var CAP_PER_CALL_SEC = 10 * 60; // one position jump can count at most 10 min (seek protection)
  var NOTES_MINUTES = 2; // reading freshly made notes counts as ~2 min

  var A = AQ.activity,
    S = AQ.store;
  if (!A || !S) return; // nothing to feed, nothing to hook

  function streakFlag() {
    return !STREAK_RECORDED_BY_APP_JS;
  }

  // ===== 1. small lookups =====
  /* { title, playlistId } of a video id from any playlist (first match), or {} */
  function describeVideo(videoId) {
    var pls = [];
    try {
      pls = S.all() || [];
    } catch (e) {
      return {};
    }
    for (var i = 0; i < pls.length; i++) {
      var k = S.indexOfVideo ? S.indexOfVideo(pls[i], videoId) : -1;
      if (k >= 0) return { title: pls[i].videos[k].title, playlistId: pls[i].id };
    }
    return {};
  }

  // ===== 2. watch time from position deltas =====
  /* open[videoId] = { sessionId (null until the first minute counted), lastPos, lastAt } */
  var open = {};
  function countWatch(videoId, pos, patch) {
    var now = Date.now(),
      o = open[videoId];
    if (o && now - o.lastAt <= SITTING_GAP_MS) {
      var delta = pos - o.lastPos; // seconds moved forward since the last save
      if (delta > 0) {
        var minutes = Math.min(delta, CAP_PER_CALL_SEC) / 60;
        if (o.sessionId) A.extend(o.sessionId, minutes);
        else {
          var d = describeVideo(videoId);
          var s = A.log("watch", {
            videoId: videoId,
            title: d.title,
            playlistId: d.playlistId,
            minutes: minutes,
            streak: streakFlag()
          });
          o.sessionId = s ? s.id : null;
        }
      }
    } else {
      o = open[videoId] = { sessionId: null, lastPos: pos, lastAt: now };
    }
    o.lastPos = pos;
    o.lastAt = now;
    if (patch.ended) delete open[videoId]; // the next play of this video starts a fresh session
  }
  function hookWatch() {
    var orig = S.watchSave;
    if (typeof orig !== "function") return;
    S.watchSave = function (id, patch) {
      try {
        if (patch && typeof id === "string" && typeof patch.pos === "number" && isFinite(patch.pos))
          countWatch(id, patch.pos, patch);
        else if (patch && patch.ended) delete open[id];
      } catch (e) {
        /* counting must never break playback */
      }
      return orig.apply(this, arguments);
    };
  }

  // ===== 3. notes finished =====
  function hookNotes() {
    var N = AQ.notesJobs;
    if (!N || typeof N.subscribe !== "function") return;
    var last = {}; // videoId -> last seen state
    N.subscribe(function (videoId, st) {
      var prev = last[videoId],
        now = st && st.state;
      last[videoId] = now;
      if (now !== "ready" || (prev !== "queued" && prev !== "running")) return; // only a fresh "ready"
      try {
        var d = describeVideo(videoId);
        A.log("notes", {
          videoId: videoId,
          title: d.title,
          playlistId: d.playlistId,
          minutes: NOTES_MINUTES,
          streak: streakFlag()
        });
      } catch (e) {
        /* ignore */
      }
    });
  }

  // ===== 4. playlists created =====
  function hookPlaylists() {
    ["create", "createWithVideos"].forEach(function (name) {
      var orig = S[name];
      if (typeof orig !== "function") return;
      S[name] = function () {
        var res = orig.apply(this, arguments);
        if (res) {
          var p = res.playlist || res; // createWithVideos returns { playlist, added, skipped }
          try {
            A.log("playlist", { playlistId: p.id, title: p.name, minutes: 0, streak: streakFlag() });
          } catch (e) {
            /* ignore */
          }
        }
        return res;
      };
    });
  }

  hookWatch();
  hookNotes();
  hookPlaylists();

  AQ.activityHooks = { STREAK_RECORDED_BY_APP_JS: STREAK_RECORDED_BY_APP_JS }; // visible for debugging only
})(window.AQ);

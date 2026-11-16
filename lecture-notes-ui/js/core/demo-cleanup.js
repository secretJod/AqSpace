/* =====================================================================================================
   What this file does:
     Removes the sample ("demo") data that the old `?demo=dashboard` / `?demo=streak` switches wrote into
     this browser, so the dashboard only shows real usage. The demo switches themselves are gone from the
     code; this file only cleans up what they left behind. It runs once per browser.

   How it fits:
     Loaded FIRST, before store.js and the dashboard scripts, because those read localStorage when they
     load. It only edits localStorage (no DOM, no network). The server copy of the demo watch progress
     was deleted separately; removing it here too stops this browser from uploading it again on sync.

   How demo data is recognised (real data is never matched):
     - activity log  : demo session ids are the 13-char id plus a suffix ("…3", "…n3"), real ids are 13 chars
     - streak        : the demo always set `freezes: 2`; real use never sets freezes. When found, the
                       streak days are rebuilt from the (cleaned) real activity log
     - goals         : ids "demo-playlist", "demo-minutes", "demo-notes"
     - sticky notes  : the four sample notes, matched on exact title + text
     - watch progress: whole-second positions at exactly 62/35/48/70/30/55 % of a whole-second duration
     - badges seen   : reset when demo data was found (the demo streak "unlocked" them)

   Start reading at:
     run() at the bottom.
   ===================================================================================================== */
(function () {
  "use strict";

  var DONE_KEY = "aq.demo-cleanup.v1";
  var K = {
    activity: "aq.activitylog.v1",
    streak: "aq.activity.v1",
    goals: "aq.goals.v1",
    sticky: "aq.sticky.v1",
    watch: "aq.watch.v1",
    seen: "aq.achievements.seen.v1"
  };

  function read(key) { try { var s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function write(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* storage blocked: nothing to clean */ } }

  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function dayKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

  // ===== 1. activity log: keep only real sessions =====
  function cleanActivity() {
    var arr = read(K.activity);
    if (!Array.isArray(arr)) return { real: [], removed: 0 };
    var real = arr.filter(function (s) { return s && typeof s.id === "string" && s.id.length <= 13; });
    if (real.length !== arr.length) write(K.activity, real);
    return { real: real, removed: arr.length - real.length };
  }

  // ===== 2. streak: rebuild from real sessions when the demo history is present =====
  function cleanStreak(realSessions) {
    var st = read(K.streak);
    if (!st || +st.freezes !== 2) return false;
    var days = {};
    realSessions.forEach(function (s) {
      var d = new Date(s.start); if (isNaN(d.getTime())) return;
      var k = dayKey(d), row = days[k] || (days[k] = { count: 0, kinds: {}, minutes: 0 });
      row.count += 1;
      row.kinds[s.kind] = (row.kinds[s.kind] || 0) + 1;
      row.minutes += +s.minutes || 0;
    });
    write(K.streak, { days: days, freezes: 0 });
    return true;
  }

  // ===== 3. goals and sticky notes =====
  function cleanGoals() {
    var arr = read(K.goals);
    if (!Array.isArray(arr)) return 0;
    var keep = arr.filter(function (g) { return !(g && /^demo-(playlist|minutes|notes)$/.test(g.id)); });
    if (keep.length !== arr.length) write(K.goals, keep);
    return arr.length - keep.length;
  }
  var DEMO_NOTES = [
    "Revise backprop|Re-watch 12:40–18:00 of the neural network video.\nWrite the chain rule by hand once.",
    "Question for later|Why does attention scale by √d?",
    "This week|• Finish Data Science playlist\n• 3 sets of notes\n• 30 min a day",
    "Idea|Make flashcards from the LLM notes."
  ];
  function cleanSticky() {
    var arr = read(K.sticky);
    if (!Array.isArray(arr)) return 0;
    var keep = arr.filter(function (n) { return !(n && DEMO_NOTES.indexOf(n.title + "|" + n.text) >= 0); });
    if (keep.length !== arr.length) write(K.sticky, keep);
    return arr.length - keep.length;
  }

  // ===== 4. watch progress written by the demo =====
  var DEMO_SHARES = [0.62, 0.35, 0.48, 0.7, 0.3, 0.55];
  function isDemoWatch(w) {
    if (!w || w.done || !Number.isInteger(w.pos) || !Number.isInteger(w.dur) || w.dur < 1) return false;
    return DEMO_SHARES.some(function (sh) { return w.pos === Math.round(w.dur * sh); });
  }
  function cleanWatch() {
    var map = read(K.watch);
    if (!map || typeof map !== "object") return 0;
    var n = 0;
    Object.keys(map).forEach(function (id) { if (isDemoWatch(map[id])) { delete map[id]; n++; } });
    if (n) write(K.watch, map);
    return n;
  }

  function run() {
    try { if (localStorage.getItem(DONE_KEY)) return; } catch (e) { return; }
    var act = cleanActivity();
    var streak = cleanStreak(act.real);
    var goals = cleanGoals(), notes = cleanSticky(), watch = cleanWatch();
    if (act.removed || streak || goals || notes) { try { localStorage.removeItem(K.seen); } catch (e) { /* ignore */ } }
    try { localStorage.setItem(DONE_KEY, new Date().toISOString()); } catch (e) { /* ignore */ }
    if (act.removed || streak || goals || notes || watch) {
      try { console.info("[AQ] removed demo data: " + act.removed + " sessions, streak " + (streak ? "rebuilt" : "kept") + ", " + goals + " goals, " + notes + " notes, " + watch + " watch entries"); } catch (e) { /* no console */ }
    }
  }
  run();
})();

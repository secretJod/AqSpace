/* =====================================================================================================
   What this file does:
     The activity log (`AQ.activity`): a compact list of learning sessions (watched a video, notes
     finished, playlist created, a review). Every dashboard chart and the goals card read their numbers
     from here. No DOM code in this file.

   How it fits:
     Loaded after streak.js and before activity-hooks.js / goals.js / hud-metrics.js / dashboard.js.
     activity-hooks.js writes sessions with `log()` and `extend()` while the app is used. Readers call
     `minutesByDay`, `minutesByHour`, `weekdayHeat`, `totals`, `count`, `recent` and re-draw from
     `subscribe(fn)`. Each `log()` also calls `AQ.streak.record(kind, 1, {minutes})`, so the activity
     log is the one place that feeds the streak.

   Storage:
     localStorage key `aq.activitylog.v1` = JSON array of sessions, oldest first:
       Session = { id, kind: "watch"|"notes"|"playlist"|"review", videoId?, playlistId?, title?,
                   start (ISO), minutes (number, may be 0), hour (0-23, local hour of `start`) }
     Days are LOCAL calendar days. Every stored field is re-validated on load because localStorage can
     be edited by hand or by another tab. If storage is blocked the log keeps working in memory.

   Start reading at:
     `log()` (section 3), then `minutesByDay()` (section 4).
   ===================================================================================================== */
window.AQ = window.AQ || {};
(function (AQ) {
  "use strict";

  var KEY = "aq.activitylog.v1";
  var KINDS = ["watch", "notes", "playlist", "review"];
  var MAX_SESSIONS = 5000; // oldest sessions are dropped past this (keeps the JSON small)
  var MAX_MINUTES = 24 * 60; // one session can never be longer than a day
  var ID_RE = /^[A-Za-z0-9_-]{11}$/; // YouTube video id
  var PID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

  var sessions = [];
  var listeners = [];
  var emitTimer = null;

  // ===== 1. date helpers (local calendar days) =====
  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }
  function dayKey(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }
  function today() {
    return startOfDay(new Date());
  }
  function weekdayIdx(d) {
    return (d.getDay() + 6) % 7;
  } // Mon = 0 ... Sun = 6
  /* Accepts a Date, an ISO string, a "YYYY-MM-DD" day or a timestamp; null when unreadable. */
  function toDate(x) {
    if (x == null) return null;
    if (x instanceof Date) return isNaN(x.getTime()) ? null : x;
    if (typeof x === "number") return new Date(x);
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(x));
    if (m) return new Date(+m[1], m[2] - 1, +m[3]);
    var t = Date.parse(x);
    return isNaN(t) ? null : new Date(t);
  }
  function num(x) {
    x = +x;
    return isFinite(x) && x > 0 ? x : 0;
  }
  function round1(x) {
    return Math.round(x * 10) / 10;
  }

  // ===== 2. persistence =====
  function cleanSession(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (KINDS.indexOf(raw.kind) < 0) return null;
    var start = toDate(raw.start);
    if (!start) return null;
    var s = {
      id: typeof raw.id === "string" && raw.id ? raw.id.slice(0, 24) : newId(),
      kind: raw.kind,
      start: start.toISOString(),
      minutes: round1(Math.min(MAX_MINUTES, num(raw.minutes))),
      hour: start.getHours()
    };
    if (typeof raw.videoId === "string" && ID_RE.test(raw.videoId)) s.videoId = raw.videoId;
    if (typeof raw.playlistId === "string" && PID_RE.test(raw.playlistId)) s.playlistId = raw.playlistId;
    if (typeof raw.title === "string" && raw.title.trim()) s.title = raw.title.trim().slice(0, 150);
    return s;
  }
  function byStart(a, b) {
    return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
  }
  function load() {
    var raw = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch {
      /* storage blocked: start empty and keep the log in memory */
    }
    if (!raw) return;
    var arr;
    try {
      arr = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(arr)) return;
    var seen = {};
    sessions = [];
    arr.forEach(function (r) {
      var s = cleanSession(r);
      if (s && !seen[s.id]) {
        seen[s.id] = 1;
        sessions.push(s);
      }
    });
    sessions.sort(byStart);
  }
  function save() {
    if (sessions.length > MAX_SESSIONS) sessions.splice(0, sessions.length - MAX_SESSIONS);
    try {
      localStorage.setItem(KEY, JSON.stringify(sessions));
    } catch {
      /* storage blocked or full: the in-memory log stays correct for this tab */
    }
  }
  /* Subscribers are told at most a few times per second (watch sessions grow every second). */
  function emit(evt) {
    if (emitTimer) return;
    emitTimer = setTimeout(function () {
      emitTimer = null;
      listeners.slice().forEach(function (fn) {
        try {
          fn(evt || {});
        } catch {
          /* one bad listener must not stop the rest */
        }
      });
    }, 250);
  }
  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ===== 3. writing =====
  /**
   * Adds a session that starts now and tells AQ.streak about it.
   * @param {"watch"|"notes"|"playlist"|"review"} kind
   * @param {{videoId?: string, playlistId?: string, title?: string, minutes?: number, streak?: boolean}} [opts]
   *   `streak: false` skips the AQ.streak.record call.
   * @returns {object|null} the stored session, or null for an unknown kind
   */
  function log(kind, opts) {
    opts = opts || {};
    var s = cleanSession({
      id: newId(),
      kind: kind,
      start: new Date(),
      minutes: opts.minutes,
      videoId: opts.videoId,
      playlistId: opts.playlistId,
      title: opts.title
    });
    if (!s) return null;
    sessions.push(s);
    save();
    if (opts.streak !== false) recordStreak(s.kind, s.minutes);
    emit({ type: "log", session: s });
    return s;
  }
  /**
   * Adds minutes to an open session. The player saves its position every second, so one session per
   * sitting (grown here) keeps the log small.
   * @param {string} id session id returned by log()
   * @param {number} minutes minutes to add (ignored unless > 0)
   * @returns {object|null} the updated session, or null when the id is unknown or nothing was added
   */
  function extend(id, minutes) {
    var s = find(id),
      add = num(minutes);
    if (!s || !add) return null;
    s.minutes = round1(Math.min(MAX_MINUTES, s.minutes + add));
    save();
    emit({ type: "extend", session: s });
    return s;
  }
  function find(id) {
    for (var i = sessions.length - 1; i >= 0; i--) if (sessions[i].id === id) return sessions[i];
    return null;
  }
  function recordStreak(kind, minutes) {
    var S = AQ.streak;
    if (!S || typeof S.record !== "function") return;
    try {
      S.record(kind, 1, { minutes: minutes });
    } catch {
      /* the streak is a bonus, never a blocker */
    }
  }

  // ===== 4. reading =====
  /** Sessions in a range: { from, to } (Date / ISO / "YYYY-MM-DD"; both inclusive, both optional). Oldest first. */
  function list(range) {
    range = range || {};
    var from = toDate(range.from),
      to = toDate(range.to);
    // a bare day as "to" means the whole of that day
    if (to && typeof range.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(range.to)) to = addDays(to, 1);
    var fromIso = from ? from.toISOString() : null,
      toIso = to ? to.toISOString() : null;
    return sessions.filter(function (s) {
      return (!fromIso || s.start >= fromIso) && (!toIso || s.start < toIso);
    });
  }
  function sumMinutes(arr) {
    var t = 0;
    arr.forEach(function (s) {
      t += s.minutes;
    });
    return round1(t);
  }

  /**
   * Minutes per day for the last `days` days, today included, oldest first.
   * @param {number} [days=7]
   * @returns {{date: string, minutes: number, byKind: Object<string, number>, count: number}[]}
   */
  function minutesByDay(days) {
    days = Math.max(1, Math.floor(+days || 7));
    var t = today(),
      first = addDays(t, -(days - 1)),
      out = [],
      byKey = {};
    for (var i = 0; i < days; i++) {
      var k = dayKey(addDays(first, i));
      byKey[k] = { date: k, minutes: 0, byKind: {}, count: 0 };
      out.push(byKey[k]);
    }
    list({ from: first }).forEach(function (s) {
      var row = byKey[dayKey(new Date(s.start))];
      if (!row) return;
      row.minutes = round1(row.minutes + s.minutes);
      row.byKind[s.kind] = round1((row.byKind[s.kind] || 0) + s.minutes);
      row.count++;
    });
    return out;
  }
  /**
   * Minutes studied per local hour of day, over all time.
   * @returns {number[]} 24 numbers, index = hour
   */
  function minutesByHour() {
    var out = [];
    for (var h = 0; h < 24; h++) out.push(0);
    sessions.forEach(function (s) {
      out[s.hour] = round1(out[s.hour] + s.minutes);
    });
    return out;
  }
  /**
   * Minutes per weekday and hour, over all time (the heatmap data).
   * @returns {number[][]} 7 rows (Mon..Sun) of 24 numbers
   */
  function weekdayHeat() {
    var out = [];
    for (var d = 0; d < 7; d++) {
      out.push([]);
      for (var h = 0; h < 24; h++) out[d].push(0);
    }
    sessions.forEach(function (s) {
      var d = weekdayIdx(new Date(s.start));
      out[d][s.hour] = round1(out[d][s.hour] + s.minutes);
    });
    return out;
  }
  /**
   * Minute totals for the usual periods.
   * @returns {{today: number, week: number, lastWeek: number, month: number, allTime: number}}
   *   `week` runs Monday..today, `lastWeek` is the full previous week, `month` the calendar month.
   */
  function totals() {
    var t = today(),
      monday = addDays(t, -weekdayIdx(t)),
      month1 = new Date(t.getFullYear(), t.getMonth(), 1);
    return {
      today: sumMinutes(list({ from: t })),
      week: sumMinutes(list({ from: monday })),
      lastWeek: sumMinutes(list({ from: addDays(monday, -7), to: monday })),
      month: sumMinutes(list({ from: month1 })),
      allTime: sumMinutes(sessions)
    };
  }
  /**
   * Counts sessions of one kind in a range (goals use it for "3 notes this week").
   * @param {string} [kind] session kind; empty counts every kind
   * @param {{from?: *, to?: *}} [range] see list()
   * @returns {number}
   */
  function count(kind, range) {
    return list(range).filter(function (s) {
      return !kind || s.kind === kind;
    }).length;
  }
  /**
   * The newest sessions.
   * @param {number} [n=10]
   * @returns {object[]} newest first
   */
  function recent(n) {
    n = Math.max(1, Math.floor(+n || 10));
    return sessions.slice(-n).reverse();
  }
  /**
   * Calls `fn(event)` after the log changes (batched, at most every 250 ms).
   * @param {function({type: string, session?: object}): void} fn
   * @returns {function(): void} unsubscribe
   */
  function subscribe(fn) {
    if (typeof fn !== "function") return function () {};
    listeners.push(fn);
    return function () {
      listeners = listeners.filter(function (f) {
        return f !== fn;
      });
    };
  }

  // ===== 5. start =====
  load();
  // Another tab may write the log too: reload when it does so both tabs show the same numbers.
  try {
    window.addEventListener("storage", function (e) {
      if (e.key === KEY) {
        load();
        emit({ type: "sync" });
      }
    });
  } catch {
    /* no window */
  }

  AQ.activity = {
    log: log,
    extend: extend,
    minutesByDay: minutesByDay,
    minutesByHour: minutesByHour,
    weekdayHeat: weekdayHeat,
    totals: totals,
    count: count,
    recent: recent,
    subscribe: subscribe
  };
})(window.AQ);

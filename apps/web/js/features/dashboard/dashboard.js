/* =====================================================================================================
   What this file does:
     The dashboard screen (`AQ.dashboardView`) as a HUD grid of cards. Every card is COMPACT by default
     (one idea per tile: a sparkline, a rings cluster, a clock arc, a thumbnail ...) and EXPANDS into a
     full, detailed view (the stacked bar chart with ranges, the 7x24 heatmap, the whole goals list ...).
     Also the generic "Coming soon" screen (`AQ.comingSoonView`) used by the AI route.

   How it fits:
     app.js mounts `AQ.dashboardView` for #/dashboard. Data comes from
       - AQ.activity   (activity-log.js: minutes per day / hour, sessions)  - optional, every call is guarded
       - AQ.store      (playlists + watch progress)
       - AQ.hudMetrics (hud-metrics.js: the derived numbers)                 - optional
       - AQ.goals / AQ.goalsView (goals.js: data + the full goals list)      - optional
       - AQ.streakView (streak.js: compact hero card that expands itself)    - optional
       - AQ.stickyBoard (sticky-board.js: the board card)                    - optional
     Drawing helpers: AQ.charts (charts.js), AQ.hudGauges (hud-gauges.js), AQ.hud (hud.js) and
     AQ.neural (neural.js). The expand behaviour comes from expand.js (`AQ.expand.attach`) and the
     hover / reveal / count-up effects from motion.js (`AQ.motion.*`). All optional: without them the
     cards are static. Everything is built with DOM APIs and textContent (no innerHTML), so playlist
     and video titles can never inject markup. Styles: css/dashboard.css, css/hud.css, css/mirror.css.

     `?open=<cardId>` in the page query opens that card's full view right after the dashboard mounts.

   Start reading at:
     `mount()` in section 6, then `card()` + `attachExpand()` in section 4, then one builder in section 5.
     Each builder returns { id, node, title, refresh(tot), destroy(), renderFull(container) }.
   ===================================================================================================== */
(function () {
  "use strict";
  var el = AQ.util.el;
  var DAY = 86400000;
  var RANGES = [7, 30, 90]; // the segmented control of the expanded "Time studied" card
  var SVG_NS = "http://www.w3.org/2000/svg";

  // One accent colour per card (drives --card-accent: glow, chart colour, rings). The palette is kept
  // small on purpose: cyan for most cards, amber for the streak, green for goals, paper yellow for the
  // board. A card's identity comes from its module code (below), not from its colour.
  var ACCENT = {
    streak: "#ffb020",
    today: "#5fd4ff",
    goals: "#3ddc84",
    time: "#5fd4ff",
    best: "#5fd4ff",
    playlists: "#5fd4ff",
    continue: "#5fd4ff",
    split: "#5fd4ff",
    board: "#ffe27a",
    vitals: "#5fd4ff"
  };
  // The HUD module code shown before every card's name ("MOD.04 // TIME FLOW").
  var MODULE = {
    streak: "MOD.01",
    today: "MOD.02",
    goals: "MOD.03",
    time: "MOD.04",
    best: "MOD.05",
    playlists: "MOD.06",
    split: "MOD.07",
    continue: "MOD.08",
    board: "MOD.09",
    vitals: "SYS.00"
  };
  function gauges() {
    return window.AQ && AQ.hudGauges ? AQ.hudGauges : null;
  }
  function metrics() {
    return safe(function () {
      return AQ.hudMetrics.compute();
    }, null);
  }

  // ===== 1. Small helpers (dates, text, motion) =====
  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }
  function dayKey(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function daysAgo(n) {
    var t = startOfDay(new Date());
    return new Date(t.getTime() - n * DAY);
  }
  // "2025-11-12" -> local Date (midnight). Anything else goes through Date().
  function parseDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
  }
  function shortDate(d) {
    try {
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
      return d.toDateString();
    }
  }
  function weekday(d) {
    try {
      return d.toLocaleDateString(undefined, { weekday: "short" });
    } catch {
      return d.toDateString().slice(0, 3);
    }
  }
  function longDate(d) {
    try {
      return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    } catch {
      return d.toDateString();
    }
  }
  function clockTime(d) {
    try {
      return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    } catch {
      return d.toTimeString().slice(0, 5);
    }
  }
  function fmtMin(min) {
    return AQ.charts ? AQ.charts.fmtMinutes(min) : Math.round(min) + " min";
  }
  // "4h 09m" / "42m": the short HUD form for chips where "4 hr 9 min" would not fit
  function fmtShort(min) {
    min = Math.round(+min || 0);
    return min < 60 ? min + "m" : Math.floor(min / 60) + "h " + pad(min % 60) + "m";
  }
  function hourLabel(h) {
    return AQ.charts ? AQ.charts.hourLabel(h) : h + ":00";
  }
  function reducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }
  function safe(fn, fallback) {
    try {
      var r = fn();
      return r == null ? fallback : r;
    } catch {
      return fallback;
    }
  }
  function svg(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    for (var a in attrs) n.setAttribute(a, attrs[a]);
    return n;
  }
  function motion() {
    return window.AQ && AQ.motion ? AQ.motion : null;
  }

  // "Good morning" / "Good afternoon" / ... for the current hour
  function greeting(d) {
    var h = (d || new Date()).getHours();
    if (h < 5) return "Good night";
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
  }

  // Counts a number up from 0 to `target` inside `node`. Uses motion.js when present, otherwise a local
  // ease-out; instant when motion is reduced. `format(n)` turns the number into text (default: "123").
  function countUp(node, target, format) {
    target = Math.round(+target || 0);
    // always round the in-between values, otherwise a count-up shows "85.6625..." while animating
    var userFormat =
      format ||
      function (n) {
        return String(n);
      };
    format = function (n) {
      return userFormat(Math.round(+n || 0));
    };
    var m = motion();
    if (m && typeof m.countUp === "function") {
      if (
        safe(function () {
          m.countUp(node, target, { duration: 800, format: format });
          return true;
        }, false)
      )
        return;
    }
    if (reducedMotion() || target === 0) {
      node.textContent = format(target);
      return;
    }
    var t0 = 0,
      dur = 800;
    function step(ts) {
      if (!t0) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      p = 1 - Math.pow(1 - p, 3); // ease-out
      node.textContent = format(Math.round(target * p));
      if (p < 1 && node.isConnected) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ===== 2. Activity data (AQ.activity when present, otherwise safe empty values) =====
  // Every function here returns something usable even without activity-log.js, so cards never crash.
  function activity() {
    return window.AQ && AQ.activity ? AQ.activity : null;
  }

  // Fallback when activity-log.js is missing: build day rows from the streak's day records (minutes only).
  function daysFromStreak(days) {
    var recs = safe(function () {
      return AQ.streak.days();
    }, {});
    var out = [];
    for (var i = days - 1; i >= 0; i--) {
      var d = daysAgo(i),
        k = dayKey(d),
        r = recs[k];
      var min = r ? Math.round(r.minutes || 0) : 0;
      out.push({ date: k, minutes: min, byKind: { watch: min, notes: 0 } });
    }
    return out;
  }
  function minutesByDay(days) {
    var a = activity();
    var rows = a
      ? safe(function () {
          return a.minutesByDay(days);
        }, null)
      : null;
    return Array.isArray(rows) ? rows : daysFromStreak(days);
  }
  function totals() {
    var a = activity();
    var t = a
      ? safe(function () {
          return a.totals();
        }, null)
      : null;
    if (t) return t;
    // sum the fallback rows ourselves
    var rows = daysFromStreak(60),
      sum = { today: 0, week: 0, lastWeek: 0, month: 0, allTime: 0 };
    rows.forEach(function (r, i) {
      var back = rows.length - 1 - i; // 0 = today
      sum.allTime += r.minutes;
      if (back === 0) sum.today += r.minutes;
      if (back < 7) sum.week += r.minutes;
      else if (back < 14) sum.lastWeek += r.minutes;
      if (back < 30) sum.month += r.minutes;
    });
    return sum;
  }
  function minutesByHour() {
    var a = activity(),
      h = a
        ? safe(function () {
            return a.minutesByHour();
          }, null)
        : null;
    if (Array.isArray(h) && h.length === 24) return h;
    var z = [];
    for (var i = 0; i < 24; i++) z.push(0);
    return z;
  }
  function weekdayHeat() {
    var a = activity(),
      m = a
        ? safe(function () {
            return a.weekdayHeat();
          }, null)
        : null;
    if (Array.isArray(m) && m.length === 7) return m;
    var z = [];
    for (var r = 0; r < 7; r++) {
      z[r] = [];
      for (var c = 0; c < 24; c++) z[r][c] = 0;
    }
    return z;
  }
  function recent(n) {
    var a = activity(),
      list = a
        ? safe(function () {
            return a.recent(n);
          }, null)
        : null;
    return Array.isArray(list) ? list : [];
  }
  function subscribeActivity(fn) {
    var a = activity();
    if (!a || typeof a.subscribe !== "function") return null;
    return safe(function () {
      return a.subscribe(fn);
    }, null);
  }
  // "playlist" sessions are bookkeeping (0 minutes, no title), so lists only show study time
  function isStudy(s) {
    return s && s.kind !== "playlist";
  }
  // Sessions of one local day ("YYYY-MM-DD"), newest first.
  function sessionsOn(dayK) {
    var d = parseDay(dayK),
      from = d.getTime(),
      to = from + DAY;
    return recent(2000).filter(function (s) {
      var t = new Date(s.start).getTime();
      return isStudy(s) && t >= from && t < to;
    });
  }
  // Minutes per day (oldest first) for one playlist over the last `days` days.
  function minutesByDayForPlaylist(pid, days) {
    var out = [],
      index = {};
    for (var i = days - 1; i >= 0; i--) {
      index[dayKey(daysAgo(i))] = out.length;
      out.push(0);
    }
    var from = daysAgo(days - 1).getTime();
    recent(3000).forEach(function (s) {
      if (!s || s.playlistId !== pid) return;
      var t = new Date(s.start);
      if (isNaN(t) || t.getTime() < from) return;
      var k = dayKey(t);
      if (index[k] != null) out[index[k]] += +s.minutes || 0;
    });
    return out.map(Math.round);
  }
  // Notes made this week: `count()` from activity-log.js when it exists, else counted from recent sessions.
  function notesThisWeek() {
    var a = activity(),
      from = daysAgo(6);
    if (a && typeof a.count === "function")
      return safe(function () {
        return a.count("notes", { from: from });
      }, 0);
    var n = 0;
    recent(1000).forEach(function (s) {
      if (s && s.kind === "notes" && new Date(s.start).getTime() >= from.getTime()) n++;
    });
    return n;
  }

  // ===== 3. Store data (playlists, watch progress) =====
  // Every playlist with its progress, most complete first.
  function courseRows() {
    var S = AQ.store;
    return S.all()
      .map(function (p) {
        var pr = S.progress(p);
        return { id: p.id, name: p.name, pct: pr.pct, done: pr.done, total: pr.total, timeText: S.progressTime(pr) };
      })
      .sort(function (a, b) {
        return b.pct - a.pct;
      });
  }
  // Videos with a watch record, newest first: [{playlist, video, info}]. Unfinished ones rank first
  // when `partialFirst` is set (the "continue learning" pick).
  function watchedList(n, partialFirst) {
    var S = AQ.store,
      out = [];
    S.all().forEach(function (p) {
      p.videos.forEach(function (v) {
        var w = S.watchInfo(v.id, AQ.util.parseDuration(v.duration));
        if (!w.updated || w.pos < 1) return;
        out.push({ playlist: p, video: v, info: w });
      });
    });
    out.sort(function (a, b) {
      if (partialFirst && (a.info.state === "partial") !== (b.info.state === "partial"))
        return a.info.state === "partial" ? -1 : 1;
      return b.info.updated - a.info.updated;
    });
    return out.slice(0, n);
  }
  function lastWatched() {
    return watchedList(1, true)[0] || null;
  }
  function lecturesFinished() {
    var S = AQ.store,
      seen = {},
      n = 0;
    S.all().forEach(function (p) {
      p.videos.forEach(function (v) {
        if (!seen[v.id]) {
          seen[v.id] = 1;
          if (S.isWatched(v.id)) n++;
        }
      });
    });
    return n;
  }
  // Minutes per playlist from the activity sessions of the last 30 days; otherwise watched seconds from the store.
  // Returns { labels, values, ids, total } (at most 5 named slices + "Other").
  function timeByPlaylist() {
    var S = AQ.store,
      names = {},
      min = {};
    S.all().forEach(function (p) {
      names[p.id] = p.name;
    });
    var from = daysAgo(29).getTime();
    recent(1000).forEach(function (s) {
      if (!s || !s.playlistId || !names[s.playlistId]) return;
      if (new Date(s.start).getTime() < from) return;
      min[s.playlistId] = (min[s.playlistId] || 0) + (+s.minutes || 0);
    });
    var ids = Object.keys(min);
    if (!ids.length) {
      S.all().forEach(function (p) {
        var pr = S.progress(p);
        if (pr.watchedSec > 30) min[p.id] = pr.watchedSec / 60;
      });
      ids = Object.keys(min);
    }
    ids.sort(function (a, b) {
      return min[b] - min[a];
    });
    var labels = [],
      values = [],
      keep = [],
      other = 0,
      total = 0;
    ids.forEach(function (id, i) {
      total += min[id];
      if (i < 5) {
        labels.push(names[id]);
        values.push(Math.round(min[id]));
        keep.push(id);
      } else other += min[id];
    });
    if (other > 0) {
      labels.push("Other");
      values.push(Math.round(other));
      keep.push(null);
    }
    return { labels: labels, values: values, ids: keep, total: Math.round(total) };
  }
  // The goals with their progress: [{goal, pr}] (empty without goals.js).
  function goalRows() {
    return safe(function () {
      var G = AQ.goals;
      if (!G || typeof G.list !== "function" || typeof G.progress !== "function") return [];
      return G.list()
        .map(function (g) {
          return { goal: g, pr: G.progress(g) };
        })
        .filter(function (x) {
          return x.pr;
        });
    }, []);
  }

  // ===== 4. Card shell + expand plumbing =====
  // <section class="dash__card dash__card--<id>" data-card=<id>> with an eyebrow + title row and an
  // "open" glyph. `aside` is an optional right-hand control (replaces the glyph).
  function card(id, eyebrow, title, aside) {
    var s = el("section", "dash__card dash__card--" + id);
    s.setAttribute("data-card", id);
    s.setAttribute("aria-label", title || eyebrow);
    s.style.setProperty("--card-accent", ACCENT[id] || "#ffffff");
    var head = el("div", "dash__card-head");
    var txt = el("div", "dash__card-text");
    if (eyebrow) {
      var tag = el("p", "dash__tag");
      if (MODULE[id]) {
        tag.appendChild(el("span", "dash__code", MODULE[id]));
        tag.appendChild(el("span", "dash__slash", " // "));
      }
      tag.appendChild(el("span", null, eyebrow));
      txt.appendChild(tag);
    }
    if (title) txt.appendChild(el("h2", "dash__card-title", title));
    head.appendChild(txt);
    if (aside) head.appendChild(aside);
    s.appendChild(head);
    return s;
  }
  function emptyNote(text) {
    return el("p", "dash__empty muted", text);
  }

  // The small "open" button in the card head: keyboard users always get a real button, whatever expand.js
  // does with the card itself. Clicking it must not bubble, or the card would open twice.
  function openButton(c) {
    var b = AQ.util.button("", { cls: "dash__open", icon: "external", aria: "Open " + (c.title || c.id) + " in full" });
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      openCard(c);
    });
    return b;
  }
  // Wire a card to expand.js. Without expand.js the card stays a static tile (no open glyph).
  function attachExpand(c) {
    var X = window.AQ && AQ.expand;
    if (!X || typeof X.attach !== "function" || typeof c.renderFull !== "function") {
      c.node.classList.add("dash__card--static");
      return;
    }
    c.handle = safe(function () {
      return X.attach(c.node, {
        title: c.title,
        renderFull: function (container) {
          return c.renderFull(container);
        },
        onOpen: function () {
          c.node.classList.add("is-open");
        },
        onClose: function () {
          c.node.classList.remove("is-open");
        }
      });
    }, null);
    c.node.classList.add("is-expandable");
    var head = c.node.querySelector(".dash__card-head");
    if (head && !head.querySelector(".dash__open")) head.appendChild(openButton(c));
  }
  function openCard(c) {
    if (c.handle && typeof c.handle.open === "function") {
      safe(function () {
        c.handle.open();
      });
      return;
    }
    // no handle API: expand.js listens to clicks on the card itself
    c.node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }
  // Hover spotlight + tilt from motion.js (no-ops without it or with reduced motion).
  // Returns the effect handles ({destroy}) so mount() can clean them up.
  function decorate(node, tiltMax) {
    var m = motion(),
      out = [];
    if (!m) return out;
    if (typeof m.spotlight === "function")
      out.push(
        safe(function () {
          return m.spotlight(node);
        }, null)
      );
    if (typeof m.tilt === "function" && !reducedMotion())
      out.push(
        safe(function () {
          return m.tilt(node, { max: tiltMax || 3 });
        }, null)
      );
    return out;
  }
  // A labelled number used in several full views: <div class="dstat"><p class="dstat__num">..</p><p class="dstat__label">..</p></div>
  function stat(value, label, accent) {
    var d = el("div", "dstat");
    if (accent) d.style.setProperty("--card-accent", accent);
    d.appendChild(el("p", "dstat__num", value));
    d.appendChild(el("p", "dstat__label", label));
    return d;
  }
  // The kind glyph of a session row (play / notes / plus).
  function kindGlyph(kind) {
    var g = el("span", "session__kind session__kind--" + (kind || "other"));
    g.appendChild(AQ.util.icon(kind === "notes" ? "notes" : kind === "watch" ? "play" : "plus"));
    return g;
  }

  // ===== 5. Card builders =====

  // --- 5a. header (greeting + date + a "focus for today" sentence) ---------------------------------
  // The most urgent open goal (goals.js: status + pace), otherwise derived from this week's minutes.
  function focusLine(tot) {
    var fromGoals = safe(function () {
      var open = goalRows().filter(function (x) {
        return x.pr.status !== "done";
      });
      if (!open.length) return null;
      var rank = { behind: 0, "on track": 1, ahead: 2 }; // "behind" goals first
      open.sort(function (a, b) {
        return (rank[a.pr.status] || 0) - (rank[b.pr.status] || 0);
      });
      var top = open[0];
      return "Focus for today: " + top.goal.title + (top.pr.pace ? " — " + top.pr.pace : "") + ".";
    }, null);
    if (fromGoals) return fromGoals;
    var avg = Math.round(tot.week / 7);
    if (!tot.allTime) return "Focus for today: watch one lecture and start your streak.";
    if (tot.today >= Math.max(15, avg)) return "Focus for today: you are already ahead of your daily average. Nice.";
    return "Focus for today: about " + fmtMin(Math.max(15, avg)) + " keeps you on your weekly pace.";
  }
  // The "command bar": greeting + focus line on the left, a live hh:mm:ss clock + date on the right,
  // and a one-line system log under it (AQ.hud.ticker from hud.js, or a small local rotation).
  // Returns { node, destroy() } because the clock and the log run timers.
  function hhmmss(d) {
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }
  function buildHeader(tot, getLogLines) {
    var head = el("header", "dash__head");
    var left = el("div", "dash__hello");
    left.appendChild(el("p", "dash__sys", "AQSPACE // COMMAND DECK"));
    var title = el("h1", "pagetitle dash__title", greeting());
    title.tabIndex = -1; // so dialogs can move focus here when they close
    title.setAttribute("data-focus-fallback", "");
    left.appendChild(title);
    left.appendChild(el("p", "dash__focus", focusLine(tot)));
    head.appendChild(left);

    var right = el("div", "dash__clockbox");
    var clock = el("p", "dash__clock", hhmmss(new Date()));
    // role=timer with aria-live off: a clock that ticks every second must not flood screen readers
    clock.setAttribute("role", "timer");
    clock.setAttribute("aria-live", "off");
    right.appendChild(clock);
    var date = el("p", "dash__date", longDate(new Date()).toUpperCase());
    right.appendChild(date);
    head.appendChild(right);

    // the system log repeats numbers shown on the cards, so it is decoration for screen readers
    var log = el("div", "dash__log");
    log.setAttribute("aria-hidden", "true");
    log.appendChild(el("span", "dash__log-tag", "SYS.LOG"));
    var logLine = el("div", "dash__log-line");
    log.appendChild(logLine);
    head.appendChild(log);

    var timer = setInterval(function () {
      var d = new Date();
      clock.textContent = hhmmss(d);
      if (d.getSeconds() === 0) date.textContent = longDate(d).toUpperCase();
    }, 1000);
    // the system log: hud.js's typed ticker when it exists, otherwise rotate the lines every 4 s
    // (and not at all under reduced motion)
    var hudTicker = null,
      logTimer = 0;
    if (window.AQ && AQ.hud && typeof AQ.hud.ticker === "function")
      hudTicker = safe(function () {
        return AQ.hud.ticker(logLine, getLogLines);
      }, null);
    if (!hudTicker) {
      var i = 0;
      var show = function () {
        var lines = safe(getLogLines, []);
        if (lines.length) {
          logLine.textContent = lines[i % lines.length];
          i++;
        }
      };
      show();
      if (!reducedMotion()) logTimer = setInterval(show, 4000);
    }
    return {
      node: head,
      destroy: function () {
        clearInterval(timer);
        clearInterval(logTimer);
        if (hudTicker && hudTicker.destroy)
          safe(function () {
            hudTicker.destroy();
          });
      }
    };
  }
  // The lines of the system log: short, factual, from the live metrics.
  function logLines() {
    var m = metrics();
    if (!m) return ["SYSTEM ONLINE"];
    var out = [
      "FOCUS SCORE " + m.focus + "/100 · CONSISTENCY " + m.consistency + "%",
      "THIS WEEK " + fmtMin(m.totals.week).toUpperCase() + " · FORECAST " + fmtMin(m.projected).toUpperCase(),
      "MOMENTUM " + (m.momentum >= 0 ? "+" : "") + m.momentum + "% VS PREVIOUS 7 DAYS",
      "DEEP-WORK SESSIONS (30D) " + m.deepWork + " · LONGEST " + fmtMin(m.longest).toUpperCase()
    ];
    if (m.peakHour >= 0)
      out.push(
        "PEAK HOUR " +
          hourLabel(m.peakHour).toUpperCase() +
          (m.bestWeekday ? " · BEST DAY " + m.bestWeekday.toUpperCase() : "")
      );
    if (m.milestone) out.push("NEXT MILESTONE " + m.milestone.name.toUpperCase() + " IN " + m.milestone.days + " DAYS");
    if (m.finish) out.push("ETA " + m.finish.name.toUpperCase() + " · " + shortDate(m.finish.date).toUpperCase());
    return out;
  }

  // --- 5b. streak hero (streak.js draws it; compact mode expands itself) ---------------------------
  function buildStreak() {
    var slot = el("section", "dash__card dash__card--bare dash__card--streak");
    slot.setAttribute("aria-label", "Your streak");
    slot.setAttribute("data-card", "streak");
    slot.style.setProperty("--card-accent", ACCENT.streak);
    var view = null;
    if (AQ.streakView && typeof AQ.streakView.mount === "function")
      view = safe(function () {
        return AQ.streakView.mount(slot, { mode: "compact" });
      }, null);
    if (!view) {
      slot.classList.add("dash__card--soon");
      slot.appendChild(el("p", "dash__tag", "Streak"));
      slot.appendChild(el("p", "dash__empty muted", "Your daily streak will show up here."));
    }
    return {
      id: "streak",
      node: slot,
      title: "Streak",
      destroy: function () {
        if (view && view.destroy)
          safe(function () {
            view.destroy();
          });
      }
    };
  }

  // --- 5c. Today: minutes today as the hero number + three small stats --------------------------------
  // Full: the four numbers big, this month / all time, and today's sessions as a timeline.
  function buildToday() {
    var wrap = card("today", "Today", null);
    var hero = el("div", "today__hero");
    var num = el("p", "today__num", "0");
    hero.appendChild(num);
    hero.appendChild(el("p", "today__label", "minutes today"));
    var delta = el("p", "today__delta");
    hero.appendChild(delta);
    wrap.appendChild(hero);
    var rows = el("ul", "today__rows");
    function row(label) {
      var li = el("li", "today__row");
      var v = el("span", "today__val", "0");
      li.appendChild(v);
      li.appendChild(el("span", "today__key", label));
      rows.appendChild(li);
      return v;
    }
    var avg = row("daily avg · 30d"),
      longest = row("longest session"),
      deep = row("deep-work sessions · 30d");
    wrap.appendChild(rows);
    var G = gauges(),
      numTicker = G ? G.ticker(num) : null;

    var last = null;
    function refresh(tot) {
      last = tot;
      if (numTicker) numTicker.set(String(Math.round(tot.today)));
      else countUp(num, tot.today);
      var m = metrics() || { dailyAvg: 0, longest: 0, deepWork: 0 };
      avg.textContent = fmtMin(m.dailyAvg);
      longest.textContent = fmtMin(m.longest);
      deep.textContent = String(m.deepWork);
      var diff = tot.week - tot.lastWeek;
      delta.className = "today__delta " + (diff > 0 ? "is-up" : diff < 0 ? "is-down" : "is-flat");
      delta.textContent = (diff > 0 ? "↑ " : diff < 0 ? "↓ " : "→ ") + fmtMin(Math.abs(diff)) + " vs last week";
    }
    function renderFull(container) {
      var tot = last || totals();
      var box = el("div", "dfull dfull--today");
      var grid = el("div", "dfull__stats");
      grid.appendChild(stat(fmtMin(tot.today), "today", ACCENT.today));
      grid.appendChild(stat(fmtMin(tot.week), "this week", ACCENT.time));
      grid.appendChild(stat(String(notesThisWeek()), "notes this week", ACCENT.streak));
      grid.appendChild(stat(String(lecturesFinished()), "lectures finished", ACCENT.goals));
      grid.appendChild(stat(fmtMin(tot.month), "this month", ACCENT.best));
      grid.appendChild(stat(fmtMin(tot.allTime), "all time", ACCENT.split));
      box.appendChild(grid);
      box.appendChild(el("h3", "dfull__h", "Today's sessions"));
      var list = el("ul", "sessions sessions--full");
      var todays = sessionsOn(dayKey(new Date()));
      if (!todays.length) list.appendChild(emptyNote("Nothing yet today. Open a lecture and it shows up here."));
      todays.forEach(function (s) {
        list.appendChild(sessionRow(s));
      });
      box.appendChild(list);
      container.appendChild(box);
      return {
        destroy: function () {
          box.remove();
        }
      };
    }
    return { id: "today", node: wrap, title: "Today", refresh: refresh, renderFull: renderFull };
  }

  // --- 5d. Goals: rings cluster (nested rings, one per goal) + "1 of 2 on track" ----------------------
  // Full: the complete goals card from goals.js (list, add / edit / delete, confetti).
  // Instrument-style: three thin concentric arcs in cyan/steel tints (outer -> inner), each with a
  // fine tick scale and its % read-out at the arc's start; the legend squares match.
  var RING_COLORS = ["#5fd4ff", "#2f8fb3", "#8aa4b8"];
  function ringsCluster(rows) {
    var size = 140,
      cx = size / 2,
      stroke = 3,
      gap = 13;
    var s = svg("svg", {
      viewBox: "0 0 " + size + " " + size,
      class: "rings is-inst",
      "aria-hidden": "true",
      focusable: "false"
    });
    // outer scale: 40 ticks, major every 10%
    for (var t = 0; t < 40; t++) {
      var ang = (t / 40) * Math.PI * 2 - Math.PI / 2,
        major = t % 4 === 0,
        r0 = size / 2 - 1,
        r1 = r0 - (major ? 6 : 3);
      s.appendChild(
        svg("line", {
          class: "rings__tick" + (major ? " is-major" : ""),
          x1: (cx + r0 * Math.cos(ang)).toFixed(2),
          y1: (cx + r0 * Math.sin(ang)).toFixed(2),
          x2: (cx + r1 * Math.cos(ang)).toFixed(2),
          y2: (cx + r1 * Math.sin(ang)).toFixed(2)
        })
      );
    }
    rows.slice(0, 3).forEach(function (x, i) {
      var r = size / 2 - 14 - i * gap,
        c = 2 * Math.PI * r;
      var color = RING_COLORS[i],
        pct = Math.min(1, Math.max(0, x.pr.percent / 100));
      s.appendChild(svg("circle", { class: "rings__track", cx: cx, cy: cx, r: r }));
      var bar = svg("circle", {
        class: "rings__bar",
        cx: cx,
        cy: cx,
        r: r,
        stroke: color,
        "stroke-width": stroke,
        "stroke-dasharray": c,
        "stroke-dashoffset": c
      });
      s.appendChild(bar);
      // final value at once; the draw-in is a CSS keyframe from --c (full circle) so a rebuild never leaves it empty
      bar.setAttribute("stroke-dashoffset", c * (1 - pct));
      bar.style.setProperty("--c", String(c));
      // end marker: a short radial notch at the value
      var ea = pct * Math.PI * 2 - Math.PI / 2;
      s.appendChild(
        svg("line", {
          class: "rings__end",
          stroke: color,
          x1: (cx + (r - 4) * Math.cos(ea)).toFixed(2),
          y1: (cx + (r - 4) * Math.sin(ea)).toFixed(2),
          x2: (cx + (r + 4) * Math.cos(ea)).toFixed(2),
          y2: (cx + (r + 4) * Math.sin(ea)).toFixed(2)
        })
      );
      var lab = svg("text", {
        class: "rings__pct",
        x: cx - 3,
        y: (cx - r + 3).toFixed(1),
        "text-anchor": "end",
        fill: color
      });
      lab.textContent = Math.round(pct * 100) + "%";
      s.appendChild(lab);
    });
    return s;
  }
  function buildGoals() {
    var wrap = card("goals", "Objectives", "Set a target");
    var title = wrap.querySelector(".dash__card-title");
    var body = el("div", "goals");
    wrap.appendChild(body);
    function refresh() {
      body.textContent = "";
      var rows = goalRows();
      var onTrack = 0,
        open = 0;
      rows.forEach(function (x) {
        if (x.pr.status !== "done") {
          open++;
          if (x.pr.status !== "behind") onTrack++;
        }
      });
      title.textContent = !rows.length
        ? "Set a target"
        : !open
          ? "Everything done"
          : onTrack + " of " + open + " on track";
      if (!rows.length) {
        body.appendChild(
          emptyNote(
            AQ.goals
              ? "Finish a playlist by a date, study 30 min a day, or tick off a checklist."
              : "Set a target and track it here."
          )
        );
        return;
      }
      // order: open goals first (behind, on track, ahead), done last, so the outer ring is the one that matters
      var rank = { behind: 0, "on track": 1, ahead: 2, done: 3 };
      rows.sort(function (a, b) {
        return (rank[a.pr.status] || 0) - (rank[b.pr.status] || 0);
      });
      body.appendChild(ringsCluster(rows));
      var legend = el("ul", "goals__legend");
      rows.slice(0, 3).forEach(function (x, i) {
        var li = el("li", "goals__item");
        var dot = el("span", "goals__dot");
        dot.style.setProperty("--dot", RING_COLORS[i]);
        li.appendChild(dot);
        li.appendChild(el("span", "goals__name", x.goal.title));
        li.appendChild(el("span", "goals__pct", Math.round(x.pr.percent) + "%"));
        legend.appendChild(li);
      });
      if (rows.length > 3) legend.appendChild(el("li", "goals__more muted", "+" + (rows.length - 3) + " more"));
      body.appendChild(legend);
    }
    // One line per goal: name (a link to the playlist for playlist goals), progress bar, % and pace.
    function progressList() {
      var rows = goalRows(),
        rank = { behind: 0, "on track": 1, ahead: 2, done: 3 };
      rows.sort(function (a, b) {
        return (rank[a.pr.status] || 0) - (rank[b.pr.status] || 0);
      });
      var wrapList = el("section", "gprog-wrap");
      wrapList.appendChild(
        el("h3", "gprog__h", "Progress · " + rows.length + (rows.length === 1 ? " goal" : " goals"))
      );
      var ul = el("ul", "gprog");
      rows.forEach(function (x) {
        var pct = Math.round(Math.max(0, Math.min(100, x.pr.percent || 0)));
        var li = el("li", "gprog__item is-" + String(x.pr.status || "").replace(/\s+/g, "-"));
        var top = el("div", "gprog__top");
        var pl = x.goal.playlistId && AQ.store.get(x.goal.playlistId);
        var name;
        if (pl) {
          name = el("a", "gprog__name", x.goal.title);
          name.href = "#/playlist/" + pl.id;
          name.title = "Open " + pl.name;
        } else name = el("span", "gprog__name", x.goal.title);
        top.appendChild(name);
        top.appendChild(el("span", "gprog__pct", pct + "%"));
        li.appendChild(top);
        var bar = el("div", "gprog__bar"),
          fill = el("span", "gprog__fill");
        fill.style.width = pct + "%";
        bar.appendChild(fill);
        li.appendChild(bar);
        var meta = el("p", "gprog__meta");
        meta.appendChild(el("span", "gprog__status", x.pr.status || ""));
        meta.appendChild(document.createTextNode(x.pr.pace || x.pr.detail || ""));
        li.appendChild(meta);
        ul.appendChild(li);
      });
      wrapList.appendChild(ul);
      return wrapList;
    }
    function renderFull(container) {
      var box = el("div", "dfull dfull--goals");
      container.appendChild(box);
      // the quick overview first, the goals manager (add / edit / delete) below it
      var overview = el("div", "gprog-slot");
      box.appendChild(overview);
      function drawOverview() {
        overview.textContent = "";
        if (goalRows().length) overview.appendChild(progressList());
      }
      drawOverview();
      // keep the overview in step when a goal is added, edited or deleted in the manager below
      var unsub = safe(function () {
        return AQ.goals && AQ.goals.subscribe ? AQ.goals.subscribe(drawOverview) : null;
      }, null);
      var view = null;
      if (AQ.goalsView && typeof AQ.goalsView.mount === "function")
        view = safe(function () {
          return AQ.goalsView.mount(box);
        }, null);
      if (!view) box.appendChild(emptyNote("Goals are not available in this build."));
      return {
        destroy: function () {
          if (typeof unsub === "function") safe(unsub);
          if (view && view.destroy)
            safe(function () {
              view.destroy();
            });
          box.remove();
        }
      };
    }
    return { id: "goals", node: wrap, title: "Goals", refresh: refresh, renderFull: renderFull };
  }

  // --- 5e. Time studied: edge-to-edge 14-day area sparkline + week total -------------------------------
  // Full: stacked bars with a 7 / 30 / 90 control, averages, best day, click a bar -> that day's sessions.
  function barData(days) {
    var rows = minutesByDay(days);
    var labels = rows.map(function (r) {
      var d = parseDay(r.date);
      return days <= 7 ? weekday(d) : shortDate(d);
    });
    var watch = rows.map(function (r) {
      return Math.round((r.byKind && r.byKind.watch) || 0);
    });
    var notes = rows.map(function (r) {
      return Math.round((r.byKind && r.byKind.notes) || 0);
    });
    // anything that is neither watching nor notes (e.g. "review") goes into a third bar segment
    var other = rows.map(function (r, i) {
      return Math.max(0, Math.round(r.minutes || 0) - watch[i] - notes[i]);
    });
    var series = [
      { label: "Watching", data: watch, color: ACCENT.time },
      { label: "Notes", data: notes, color: ACCENT.streak }
    ];
    if (
      other.some(function (v) {
        return v > 0;
      })
    )
      series.push({ label: "Other", data: other, color: ACCENT.goals });
    return { labels: labels, series: series, rows: rows };
  }
  function buildTimeStudied(onPickDay) {
    var wrap = card("time", "Time flow", "This week");
    var figure = el("div", "time__figure");
    var num = el("p", "time__num", "0");
    figure.appendChild(num);
    var sub = el("p", "time__sub muted", "last 14 days");
    figure.appendChild(sub);
    wrap.appendChild(figure);
    var box = el("div", "dash__chart dash__chart--spark dash__bleed");
    var canvas = el("canvas");
    box.appendChild(canvas);
    wrap.appendChild(box);
    var axis = el("div", "time__axis muted");
    wrap.appendChild(axis);
    // three HUD chips under the line: forecast for the week, momentum, best day of the 14
    var chips = el("dl", "hudchips");
    wrap.appendChild(chips);
    function chip(label) {
      var d = el("div", "hudchip");
      d.appendChild(el("dt", null, label));
      var v = el("dd");
      d.appendChild(v);
      chips.appendChild(d);
      return v;
    }
    var fc = chip("FORECAST"),
      mo = chip("MOMENTUM"),
      bd = chip("PEAK DAY");

    var spark = null;
    function refresh(tot) {
      countUp(num, tot.week, function (n) {
        return fmtMin(n);
      });
      var rows = minutesByDay(14),
        data = rows.map(function (r) {
          return r.minutes;
        });
      var best = 0;
      rows.forEach(function (r, i) {
        if (r.minutes > rows[best].minutes) best = i;
      });
      sub.textContent = "this week · 14-day trace";
      var m = metrics();
      fc.textContent = m ? fmtShort(m.projected) : "—";
      mo.textContent = m ? (m.momentum > 0 ? "▲ +" : m.momentum < 0 ? "▼ " : "") + m.momentum + "%" : "—";
      mo.className = m && m.momentum > 0 ? "is-up" : m && m.momentum < 0 ? "is-down" : "";
      bd.textContent = rows[best] && rows[best].minutes ? shortDate(parseDay(rows[best].date)) : "—";
      axis.textContent = "";
      axis.appendChild(el("span", null, shortDate(parseDay(rows[0].date))));
      axis.appendChild(el("span", null, "today"));
      if (!spark && AQ.charts) spark = AQ.charts.area(canvas, { data: data, color: ACCENT.time, compact: true });
      else if (spark) spark.update({ data: data });
    }
    function renderFull(container) {
      var box = el("div", "dfull dfull--time");
      var range = RANGES[0],
        buttons = {};
      var seg = el("div", "seg");
      seg.setAttribute("role", "group");
      seg.setAttribute("aria-label", "Range");
      RANGES.forEach(function (n) {
        var b = el("button", "seg__btn", n + "d");
        b.type = "button";
        b.addEventListener("click", function () {
          if (n !== range) {
            range = n;
            draw();
          }
        });
        seg.appendChild(b);
        buttons[n] = b;
      });
      var top = el("div", "dfull__bar");
      var h = el("h3", "dfull__h", "Last 7 days");
      top.appendChild(h);
      top.appendChild(seg);
      box.appendChild(top);
      var stats = el("div", "dfull__stats dfull__stats--row");
      box.appendChild(stats);
      var chartBox = el("div", "dash__chart dash__chart--bars");
      var canvas = el("canvas");
      chartBox.appendChild(canvas);
      box.appendChild(chartBox);
      box.appendChild(el("p", "dash__hint muted", "Click a bar to see that day's sessions."));
      var dayTitle = el("h3", "dfull__h dfull__h--day");
      dayTitle.hidden = true;
      box.appendChild(dayTitle);
      var dayList = el("ul", "sessions sessions--full");
      box.appendChild(dayList);
      container.appendChild(box);

      var chart = null,
        data = null;
      function showDay(k) {
        dayList.textContent = "";
        dayTitle.hidden = false;
        dayTitle.textContent = "Sessions on " + shortDate(parseDay(k));
        var rows = sessionsOn(k);
        if (!rows.length) dayList.appendChild(emptyNote("No sessions that day."));
        rows.forEach(function (s) {
          dayList.appendChild(sessionRow(s));
        });
        onPickDay(k);
      }
      function draw() {
        RANGES.forEach(function (n) {
          buttons[n].setAttribute("aria-pressed", String(n === range));
          buttons[n].classList.toggle("is-on", n === range);
        });
        data = barData(range);
        h.textContent = "Last " + range + " days";
        var sum = 0,
          best = 0,
          active = 0;
        data.rows.forEach(function (r, i) {
          sum += r.minutes || 0;
          if (r.minutes > 0) active++;
          if (r.minutes > (data.rows[best].minutes || 0)) best = i;
        });
        stats.textContent = "";
        stats.appendChild(stat(fmtMin(sum), "total", ACCENT.time));
        stats.appendChild(stat(fmtMin(sum / range), "per day", ACCENT.time));
        stats.appendChild(stat(active + " / " + range, "active days", ACCENT.goals));
        stats.appendChild(
          stat(
            data.rows[best] && data.rows[best].minutes ? shortDate(parseDay(data.rows[best].date)) : "—",
            "best day" + (data.rows[best] && data.rows[best].minutes ? " · " + fmtMin(data.rows[best].minutes) : ""),
            ACCENT.streak
          )
        );
        if (!chart && AQ.charts) {
          chart = AQ.charts.bar(canvas, {
            labels: data.labels,
            series: data.series,
            stacked: true,
            maxTicks: range <= 7 ? 7 : 8,
            onClick: function (i) {
              if (data.rows[i]) showDay(data.rows[i].date);
            }
          });
        } else if (chart) chart.update({ labels: data.labels, series: data.series });
        if (chart && chart.chart) chart.chart.options.scales.x.ticks.maxTicksLimit = range <= 7 ? 7 : 8;
      }
      draw();
      return {
        destroy: function () {
          if (chart) chart.destroy();
          box.remove();
        }
      };
    }
    return {
      id: "time",
      node: wrap,
      title: "Time studied",
      refresh: refresh,
      renderFull: renderFull,
      destroy: function () {
        if (spark) spark.destroy();
      }
    };
  }

  // --- 5f. Best time of day: a 24-hour clock arc + the top 3 hours as glowing pills -------------------
  // Full: the insight sentence, the 7 x 24 heatmap and the best weekday.
  function arcPath(cx, cy, r, a0, a1) {
    // a0/a1 in degrees, 0 = top, clockwise
    function pt(a) {
      var rad = ((a - 90) * Math.PI) / 180;
      return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
    }
    var p0 = pt(a0),
      p1 = pt(a1);
    return (
      "M" +
      p0[0].toFixed(2) +
      " " +
      p0[1].toFixed(2) +
      " A" +
      r +
      " " +
      r +
      " 0 " +
      (a1 - a0 > 180 ? 1 : 0) +
      " 1 " +
      p1[0].toFixed(2) +
      " " +
      p1[1].toFixed(2)
    );
  }
  function clockArc(hours) {
    var size = 150,
      cx = size / 2,
      r = 62,
      max = 0;
    hours.forEach(function (v) {
      if (v > max) max = v;
    });
    var s = svg("svg", {
      viewBox: "0 0 " + size + " " + size,
      class: "clock",
      "aria-hidden": "true",
      focusable: "false"
    });
    for (var h = 0; h < 24; h++) {
      var a0 = h * 15 + 1.5,
        a1 = (h + 1) * 15 - 1.5;
      var level = max ? hours[h] / max : 0;
      var seg = svg("path", { d: arcPath(cx, cx, r, a0, a1), class: "clock__seg" });
      seg.style.setProperty("--lvl", level.toFixed(3));
      seg.style.setProperty("--i", String(h));
      s.appendChild(seg);
    }
    // the four quarter marks: 12 am (top), 6 am, 12 pm, 6 pm
    [
      ["12a", 0],
      ["6a", 90],
      ["12p", 180],
      ["6p", 270]
    ].forEach(function (m) {
      var rad = ((m[1] - 90) * Math.PI) / 180,
        rr = r - 14;
      var t = svg("text", {
        x: (cx + rr * Math.cos(rad)).toFixed(1),
        y: (cx + rr * Math.sin(rad) + 3).toFixed(1),
        class: "clock__mark",
        "text-anchor": "middle"
      });
      t.textContent = m[0];
      s.appendChild(t);
    });
    return s;
  }
  function topHours(hours, n) {
    return hours
      .map(function (v, h) {
        return { h: h, v: v };
      })
      .filter(function (x) {
        return x.v > 0;
      })
      .sort(function (a, b) {
        return b.v - a.v;
      })
      .slice(0, n);
  }
  function buildBestTime() {
    var wrap = card("best", "Chrono", "When you learn");
    var body = el("div", "best");
    wrap.appendChild(body);
    function refresh() {
      body.textContent = "";
      var hours = minutesByHour(),
        top = topHours(hours, 3);
      // the 24-hour radial clock (hud-gauges.js); the older opacity arc when the widgets are missing
      var face = el("div", "best__face");
      var G = gauges();
      face.appendChild(G ? G.clock24(hours, 150).node : clockArc(hours));
      body.appendChild(face);
      var side = el("div", "best__side");
      var peak = el("div", "best__peak");
      peak.appendChild(el("p", "best__cap", top.length ? "PEAK HOUR" : "NO DATA YET"));
      peak.appendChild(el("p", "best__hour", top.length ? hourLabel(top[0].h) : "—"));
      var m = metrics();
      if (m && m.bestWeekday) peak.appendChild(el("p", "best__day", "BEST DAY · " + m.bestWeekday.toUpperCase()));
      side.appendChild(peak);
      if (!top.length) side.appendChild(el("p", "best__lead", "Study a little and your best hours will show up here."));
      top = top.slice(1); // the peak is shown above; the pills list the runners-up
      var pills = el("ul", "pills");
      top.forEach(function (x, i) {
        var li = el("li", "pill");
        li.appendChild(el("span", "pill__h", hourLabel(x.h)));
        li.appendChild(el("span", "pill__v", fmtMin(x.v)));
        pills.appendChild(li);
      });
      side.appendChild(pills);
      body.appendChild(side);
    }
    function renderFull(container) {
      var box = el("div", "dfull dfull--best");
      var hours = minutesByHour(),
        top = topHours(hours, 3),
        m = weekdayHeat();
      var dayTotals = m.map(function (row) {
        var s = 0;
        row.forEach(function (v) {
          s += v;
        });
        return s;
      });
      var bestDay = 0;
      dayTotals.forEach(function (v, i) {
        if (v > dayTotals[bestDay]) bestDay = i;
      });
      var DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
      var line = el("p", "dash__insight");
      line.textContent = top.length
        ? "You learn best around " +
          hourLabel(top[0].h) +
          (dayTotals[bestDay] ? ", and " + DAYS[bestDay] + " is your strongest day." : ".")
        : "Study a little and your best hours will show up here.";
      box.appendChild(line);
      var stats = el("div", "dfull__stats dfull__stats--row");
      top.forEach(function (x, i) {
        stats.appendChild(stat(hourLabel(x.h), ["peak hour", "second", "third"][i] + " · " + fmtMin(x.v), ACCENT.best));
      });
      if (dayTotals[bestDay])
        stats.appendChild(stat(DAYS[bestDay].slice(0, 3), "best weekday · " + fmtMin(dayTotals[bestDay]), ACCENT.best));
      box.appendChild(stats);
      box.appendChild(el("h3", "dfull__h", "Every hour of every weekday"));
      var heatBox = el("div", "dash__heat");
      box.appendChild(heatBox);
      var legend = el("p", "dash__hint muted", "Brighter cells = more minutes. Hover a cell for the exact time.");
      box.appendChild(legend);
      container.appendChild(box);
      var heat = AQ.charts ? AQ.charts.heatmap(heatBox, m) : null;
      return {
        destroy: function () {
          if (heat) heat.destroy();
          box.remove();
        }
      };
    }
    return { id: "best", node: wrap, title: "Best time of day", refresh: refresh, renderFull: renderFull };
  }

  // --- 5g. Playlists: top 3 progress bars ----------------------------------------------------------
  // Full: every playlist with its bar and a 14-day sparkline of minutes spent on it.
  function courseItem(r, withSpark) {
    var li = el("li", "course");
    var a = el("a", "course__link");
    a.href = "#/playlist/" + r.id;
    var top = el("div", "course__top");
    top.appendChild(el("span", "course__name", r.name));
    top.appendChild(el("span", "course__pct", r.pct + "%"));
    a.appendChild(top);
    var bar = el("span", "course__bar");
    var fill = el("span", "course__fill");
    fill.style.width = r.pct + "%";
    bar.appendChild(fill);
    a.appendChild(bar);
    a.appendChild(
      el("span", "course__meta muted", r.done + " of " + r.total + " finished" + (r.timeText ? " · " + r.timeText : ""))
    );
    li.appendChild(a);
    if (withSpark) {
      var box = el("div", "course__spark");
      var c = el("canvas");
      box.appendChild(c);
      li.appendChild(box);
      li.spark = AQ.charts
        ? AQ.charts.area(c, {
            data: minutesByDayForPlaylist(r.id, 14),
            color: ACCENT.playlists,
            compact: true,
            drawIn: false
          })
        : null;
    }
    return li;
  }
  function buildCourses() {
    var wrap = card("playlists", "Courses", "Course completion");
    // summary chips: completion across every playlist, lectures finished, estimated finish date
    var chips = el("dl", "hudchips");
    wrap.appendChild(chips);
    function chip(label) {
      var d = el("div", "hudchip");
      d.appendChild(el("dt", null, label));
      var v = el("dd");
      d.appendChild(v);
      chips.appendChild(d);
      return v;
    }
    var comp = chip("COMPLETE"),
      lec = chip("LECTURES"),
      eta = chip("ETA");
    var list = el("ul", "courses");
    wrap.appendChild(list);
    var more = el("p", "dash__hint muted");
    wrap.appendChild(more);
    function refresh() {
      var m = metrics();
      comp.textContent = m ? m.completion + "%" : "—";
      lec.textContent = m ? m.lecturesWatched + "/" + m.lecturesTotal : "—";
      eta.textContent = m && m.finish ? shortDate(m.finish.date) : "—";
      if (m && m.finish)
        eta.parentNode.title = m.finish.name + " in about " + m.finish.days + " days at your current pace";
      list.textContent = "";
      var rows = courseRows();
      if (!rows.length) {
        list.appendChild(emptyNote("No playlists yet. Create one from the Playlists tab."));
        more.textContent = "";
        return;
      }
      rows.slice(0, 3).forEach(function (r) {
        list.appendChild(courseItem(r, false));
      });
      more.textContent = rows.length > 3 ? "+" + (rows.length - 3) + " more playlists" : "";
    }
    function renderFull(container) {
      var box = el("div", "dfull dfull--playlists");
      var rows = courseRows(),
        ul = el("ul", "courses courses--full"),
        items = [];
      if (!rows.length) ul.appendChild(emptyNote("No playlists yet. Create one from the Playlists tab."));
      rows.forEach(function (r) {
        var li = courseItem(r, true);
        items.push(li);
        ul.appendChild(li);
      });
      box.appendChild(el("p", "dash__hint muted", "Each line is the last 14 days of study time on that playlist."));
      box.appendChild(ul);
      container.appendChild(box);
      return {
        destroy: function () {
          items.forEach(function (li) {
            if (li.spark) li.spark.destroy();
          });
          box.remove();
        }
      };
    }
    return { id: "playlists", node: wrap, title: "Playlists", refresh: refresh, renderFull: renderFull };
  }

  // --- 5h. Continue learning: thumbnail with play overlay + progress strip -----------------------------
  // Full: the last 5 watched videos with resume buttons.
  function thumbOf(v, w) {
    var thumb = el("div", "cont__thumb");
    var img = el("img");
    img.src = "https://i.ytimg.com/vi/" + v.id + "/mqdefault.jpg";
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", function () {
      img.style.visibility = "hidden";
    });
    thumb.appendChild(img);
    var play = el("span", "cont__play");
    play.appendChild(AQ.util.icon("play"));
    thumb.appendChild(play);
    var prog = el("span", "cont__prog");
    var fill = el("span", "cont__prog-fill");
    fill.style.width = w.pct + "%";
    prog.appendChild(fill);
    thumb.appendChild(prog);
    return thumb;
  }
  function resumeLink(item, cls) {
    var w = item.info,
      btn = el("a", cls || "btn btn--white btn--sm cont__btn");
    btn.appendChild(AQ.util.icon("play"));
    btn.appendChild(el("span", null, w.state === "done" ? "Open playlist" : "Resume · " + AQ.store.clock(w.pos)));
    btn.href = "#/playlist/" + item.playlist.id;
    return btn;
  }
  function buildContinue() {
    var wrap = card("continue", "Resume", null);
    var body = el("div", "cont");
    wrap.appendChild(body);
    function refresh() {
      body.textContent = "";
      var last = lastWatched();
      if (!last) {
        body.appendChild(emptyNote("Nothing in progress. Pick a lecture to start."));
        var go = el("a", "btn btn--ghost btn--sm", "Browse playlists");
        go.href = "#/";
        body.appendChild(go);
        return;
      }
      var v = last.video,
        w = last.info;
      var link = el("a", "cont__cover");
      link.href = "#/playlist/" + last.playlist.id;
      link.setAttribute("aria-label", "Resume " + v.title);
      link.appendChild(thumbOf(v, w));
      body.appendChild(link);
      body.appendChild(el("h3", "cont__title", v.title));
      body.appendChild(
        el(
          "p",
          "cont__meta muted",
          last.playlist.name + (w.state === "done" ? " · finished" : " · " + w.pct + "% watched")
        )
      );
      body.appendChild(resumeLink(last));
    }
    function renderFull(container) {
      var box = el("div", "dfull dfull--continue");
      var items = watchedList(5, false),
        ul = el("ul", "watched");
      if (!items.length) ul.appendChild(emptyNote("Nothing watched yet. Pick a lecture to start."));
      items.forEach(function (it) {
        var li = el("li", "watched__item");
        li.appendChild(thumbOf(it.video, it.info));
        var txt = el("div", "watched__text");
        txt.appendChild(el("h3", "watched__title", it.video.title));
        txt.appendChild(
          el(
            "p",
            "watched__meta muted",
            it.playlist.name +
              (it.video.channel ? " · " + it.video.channel : "") +
              " · " +
              (it.info.state === "done" ? "finished" : it.info.pct + "% watched")
          )
        );
        txt.appendChild(resumeLink(it, "btn btn--ghost btn--sm"));
        li.appendChild(txt);
        ul.appendChild(li);
      });
      box.appendChild(el("p", "dash__hint muted", "Your last five lectures, newest first."));
      box.appendChild(ul);
      container.appendChild(box);
      return {
        destroy: function () {
          box.remove();
        }
      };
    }
    return { id: "continue", node: wrap, title: "Continue learning", refresh: refresh, renderFull: renderFull };
  }

  // --- 5i. Where your time goes: donut with the total in the centre --------------------------------------
  // Full: the donut plus a per-playlist table (minutes, share).
  function buildSplit() {
    var wrap = card("split", "Allocation", "By playlist");
    var box = el("div", "dash__chart dash__chart--donut");
    var canvas = el("canvas");
    box.appendChild(canvas);
    wrap.appendChild(box);
    var legend = el("ul", "split__legend");
    wrap.appendChild(legend);
    var empty = emptyNote("Watch something and the split shows up here.");
    empty.hidden = true;
    wrap.appendChild(empty);
    var chart = null;
    // short centre text so it fits inside the ring ("20 h", "45 min")
    function centre(d) {
      return { value: d.total >= 60 ? Math.round(d.total / 60) + " h" : d.total + " min", label: "last 30 days" };
    }
    function refresh() {
      var d = timeByPlaylist(),
        none = !d.values.length;
      empty.hidden = !none;
      box.hidden = none;
      legend.hidden = none;
      legend.textContent = "";
      d.labels.slice(0, 3).forEach(function (name, i) {
        var li = el("li", "split__item");
        var dot = el("span", "split__dot");
        dot.style.setProperty("--dot", AQ.charts ? AQ.charts.PALETTE[i] : "#fff");
        li.appendChild(dot);
        li.appendChild(el("span", "split__name", name));
        li.appendChild(el("span", "split__pct", d.total ? Math.round((100 * d.values[i]) / d.total) + "%" : ""));
        legend.appendChild(li);
      });
      if (none) return;
      if (!chart && AQ.charts)
        chart = AQ.charts.donut(canvas, { labels: d.labels, values: d.values, legend: "none", center: centre(d) });
      else if (chart) chart.update({ labels: d.labels, values: d.values, center: centre(d) });
    }
    function renderFull(container) {
      var box = el("div", "dfull dfull--split");
      var d = timeByPlaylist();
      var fig = el("div", "dash__chart dash__chart--donut-lg");
      var c = el("canvas");
      fig.appendChild(c);
      box.appendChild(fig);
      var table = el("table", "dtable");
      var thead = el("thead");
      var tr = el("tr");
      ["Playlist", "Time", "Share"].forEach(function (t) {
        tr.appendChild(el("th", null, t));
      });
      thead.appendChild(tr);
      table.appendChild(thead);
      var tbody = el("tbody");
      d.labels.forEach(function (name, i) {
        var row = el("tr");
        var cell = el("td", "dtable__name");
        var dot = el("span", "split__dot");
        dot.style.setProperty("--dot", AQ.charts ? AQ.charts.PALETTE[i] : "#fff");
        cell.appendChild(dot);
        if (d.ids[i]) {
          var a = el("a", null, name);
          a.href = "#/playlist/" + d.ids[i];
          cell.appendChild(a);
        } else cell.appendChild(el("span", null, name));
        row.appendChild(cell);
        row.appendChild(el("td", "dtable__num", fmtMin(d.values[i])));
        row.appendChild(el("td", "dtable__num", (d.total ? Math.round((100 * d.values[i]) / d.total) : 0) + "%"));
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      if (!d.values.length) box.appendChild(emptyNote("Watch something and the split shows up here."));
      else box.appendChild(table);
      container.appendChild(box);
      var big =
        d.values.length && AQ.charts
          ? AQ.charts.donut(c, { labels: d.labels, values: d.values, legend: "none", center: centre(d), cutout: "70%" })
          : null;
      return {
        destroy: function () {
          if (big) big.destroy();
          box.remove();
        }
      };
    }
    return {
      id: "split",
      node: wrap,
      title: "Where your time goes",
      refresh: refresh,
      renderFull: renderFull,
      destroy: function () {
        if (chart) chart.destroy();
      }
    };
  }

  // --- 5j. Recent sessions: the last 4 ------------------------------------------------------------------
  // Full: every session grouped by day with a kind filter (and the day filter from the bar chart).
  function sessionTitle(s) {
    if (s.title) return s.title;
    var p = s.playlistId && AQ.store.get(s.playlistId);
    if (p && s.videoId) {
      var i = AQ.store.indexOfVideo(p, s.videoId);
      if (i >= 0) return p.videos[i].title;
    }
    return s.kind === "notes" ? "Notes" : "Lecture";
  }
  function sessionRow(s, withDate) {
    var li = el("li", "session");
    li.appendChild(kindGlyph(s.kind));
    var txt = el("div", "session__text");
    var name = el("span", "session__title", sessionTitle(s));
    if (s.playlistId && AQ.store.get(s.playlistId)) {
      var a = el("a", "session__title", sessionTitle(s));
      a.href = "#/playlist/" + s.playlistId;
      name = a;
    }
    txt.appendChild(name);
    var when = new Date(s.start);
    txt.appendChild(
      el(
        "span",
        "session__meta muted",
        (isNaN(when) ? "" : (withDate === false ? "" : shortDate(when) + ", ") + clockTime(when) + " · ") +
          fmtMin(s.minutes)
      )
    );
    li.appendChild(txt);
    li.appendChild(el("span", "session__min", fmtMin(s.minutes)));
    return li;
  }
  // --- 5j. Sticky board: the newest notes on top, the whole board + editor when expanded ---------------
  // The notes themselves live in sticky-board.js (AQ.sticky data, AQ.stickyBoard views).
  function buildBoard() {
    var wrap = card("board", "Sticky board", "Your notes");
    var title = wrap.querySelector(".dash__card-title");
    var slot = el("div", "dash__board");
    wrap.appendChild(slot);
    var pending = null; // what the expanded board should open first
    var c = { id: "board", node: wrap, title: "Sticky board" };
    var view = AQ.stickyBoard
      ? safe(function () {
          return AQ.stickyBoard.compact(slot, {
            onOpenNote: function (id) {
              pending = { openId: id };
              openCard(c);
            },
            onNew: function () {
              pending = { startNew: true };
              openCard(c);
            }
          });
        }, null)
      : null;
    if (!view) slot.appendChild(emptyNote("The sticky board is not available in this build."));
    c.refresh = function () {
      var n = AQ.sticky ? AQ.sticky.list().length : 0;
      title.textContent = n ? "Your notes" : "Pin your first note";
    };
    c.renderFull = function (container) {
      var opts = pending || {};
      pending = null;
      var full = AQ.stickyBoard
        ? safe(function () {
            return AQ.stickyBoard.full(container, opts);
          }, null)
        : null;
      if (!full) {
        var p = emptyNote("The sticky board is not available in this build.");
        container.appendChild(p);
        return {
          destroy: function () {
            p.remove();
          }
        };
      }
      return full;
    };
    c.destroy = function () {
      if (view) view.destroy();
    };
    return c;
  }

  // --- 5k. The HUD hero: arc-reactor core (minutes this week) with orbiting satellites -------------------
  // AQ.hud.core (hud.js) draws the reactor when it exists; otherwise the fallback from hud-gauges.js.
  // Each satellite is a button that opens its card through `openById(id)` (given by mount()).
  function coreSub(m) {
    return m ? "FCST " + fmtShort(m.projected).toUpperCase() : "";
  }
  function satellites(m, openById) {
    m = m || { streak: 0, goalsOnTrack: 0, goalsOpen: 0, lecturesWatched: 0 };
    return [
      {
        id: "streak",
        label: "STREAK",
        value: m.streak + "d",
        accent: ACCENT.streak,
        onPick: function () {
          openById("streak");
        }
      },
      {
        id: "notes",
        label: "NOTES/WK",
        value: String(notesThisWeek()),
        accent: ACCENT.today,
        onPick: function () {
          openById("today");
        }
      },
      {
        id: "goals",
        label: "ON TRACK",
        value: m.goalsOnTrack + "/" + m.goalsOpen,
        accent: ACCENT.goals,
        onPick: function () {
          openById("goals");
        }
      },
      {
        id: "lectures",
        label: "LECTURES",
        value: String(m.lecturesWatched),
        accent: ACCENT.playlists,
        onPick: function () {
          openById("playlists");
        }
      }
    ];
  }
  function buildCore(openById) {
    var wrap = el("section", "dash__core");
    wrap.setAttribute("data-card", "core");
    wrap.setAttribute("aria-label", "Minutes studied this week");
    wrap.style.setProperty("--card-accent", ACCENT.time);
    wrap.appendChild(el("p", "dash__core-tag", "CORE // WEEKLY OUTPUT"));
    var centre = el("div", "dash__core-centre");
    var G = gauges(),
      core = null,
      orbit = null;
    var first = metrics();
    var opts = { label: "MIN/WEEK", value: String(Math.round(first ? first.totals.week : 0)), sub: coreSub(first) };
    if (window.AQ && AQ.hud && typeof AQ.hud.core === "function")
      core = safe(function () {
        return AQ.hud.core(centre, opts);
      }, null);
    if (!core && G) core = G.reactor(centre, opts);
    if (G) {
      orbit = G.orbit(centre, satellites(first, openById));
      wrap.appendChild(orbit.node);
    } else wrap.appendChild(centre);
    // the readout strip under the reactor: three numbers that explain the core
    var strip = el("dl", "dash__core-strip");
    function cell(label) {
      var d = el("div", "core-cell");
      d.appendChild(el("dt", null, label));
      var v = el("dd");
      d.appendChild(v);
      strip.appendChild(d);
      return v;
    }
    var today = cell("TODAY"),
      mom = cell("MOMENTUM"),
      pace = cell("PACE");
    wrap.appendChild(strip);
    function refresh() {
      var m = metrics();
      if (!m) return;
      if (core && core.set)
        safe(function () {
          core.set(String(Math.round(m.totals.week)), coreSub(m));
        });
      if (orbit) orbit.set(satellites(m, openById));
      today.textContent = fmtShort(m.totals.today);
      mom.textContent = (m.momentum > 0 ? "▲ +" : m.momentum < 0 ? "▼ " : "■ ") + m.momentum + "%";
      mom.className = m.momentum > 0 ? "is-up" : m.momentum < 0 ? "is-down" : "";
      pace.textContent = m.pace ? m.pace + "%" : "—";
    }
    return {
      id: "core",
      node: wrap,
      title: "Core",
      refresh: refresh,
      destroy: function () {
        if (core && core.destroy)
          safe(function () {
            core.destroy();
          });
        if (orbit) orbit.destroy();
      }
    };
  }

  // --- 5l. Vitals: focus score gauge + habit radar + HUD readouts --------------------------------------
  // Full: every computed value with how it is measured, the big radar and the 24-hour clock.
  // A readout row: SMALL-CAPS LABEL, a monospace value and a tick-mark level bar.
  function readout(label, accent) {
    var d = el("div", "readout");
    if (accent) d.style.setProperty("--card-accent", accent);
    d.appendChild(el("p", "readout__l", label));
    var v = el("p", "readout__v", "—");
    d.appendChild(v);
    var G = gauges(),
      bar = G ? G.tickBar(20) : null;
    if (bar) d.appendChild(bar.node);
    return {
      node: d,
      set: function (text, level) {
        v.textContent = text;
        if (bar) bar.set(level);
      }
    };
  }
  function signed(n) {
    return (n > 0 ? "+" : "") + n + "%";
  }
  // [label, text, level 0..1, explanation] for every value; shared by the compact card and the full view.
  function vitalRows(m) {
    var pct = function (n) {
      return Math.max(0, Math.min(1, n / 100));
    };
    return [
      ["CONSISTENCY", m.consistency + "%", pct(m.consistency), m.activeDays + " active days of the last 30"],
      ["DAILY AVG", fmtMin(m.dailyAvg), Math.min(1, m.dailyAvg / 60), "minutes over the last 30 days ÷ 30"],
      [
        "DEEP WORK",
        String(m.deepWork),
        m.sessions30 ? m.deepWork / m.sessions30 : 0,
        "sessions of 25 min or more, last 30 days (" + m.sessions30 + " total)"
      ],
      ["LONGEST", fmtMin(m.longest), Math.min(1, m.longest / 90), "your longest single session"],
      [
        "PACE",
        m.pace ? m.pace + "%" : "—",
        pct(m.pace),
        "this week's forecast vs " +
          (m.paceAgainst === "goal" ? "your weekly goal (" + fmtMin(m.weeklyTarget) + ")" : "last week")
      ],
      [
        "FORECAST",
        fmtMin(m.projected),
        m.weeklyTarget
          ? Math.min(1, m.projected / m.weeklyTarget)
          : Math.min(1, m.projected / Math.max(1, m.totals.lastWeek || m.projected)),
        "minutes so far ÷ days elapsed × 7"
      ],
      [
        "MOMENTUM",
        signed(m.momentum),
        Math.max(0, Math.min(1, 0.5 + m.momentum / 200)),
        "last 7 days (" + fmtMin(m.last7) + ") vs the 7 before (" + fmtMin(m.prev7) + ")"
      ],
      [
        "COMPLETION",
        m.completion + "%",
        pct(m.completion),
        m.lecturesWatched + " of " + m.lecturesTotal + " lectures finished, every playlist"
      ],
      [
        "NOTES / LECTURE",
        m.notesPerLecture.toFixed(2),
        Math.min(1, m.notesPerLecture),
        m.notesTotal + " note sessions over the lectures you opened"
      ],
      [
        "PEAK HOUR",
        m.peakHour >= 0 ? hourLabel(m.peakHour) : "—",
        m.peakHour >= 0 ? 1 : 0,
        "the hour of day with the most minutes, all time"
      ],
      [
        "BEST DAY",
        m.bestWeekday ? m.bestWeekday.slice(0, 3).toUpperCase() : "—",
        m.bestWeekday ? 1 : 0,
        "the weekday with the most minutes, all time"
      ],
      [
        "NEXT BADGE",
        m.milestone ? m.milestone.days + "d" : "MAX",
        m.milestone ? Math.min(1, m.streak / m.milestone.at) : 1,
        m.milestone
          ? "days to " + m.milestone.name + " (" + m.milestone.at + "-day streak)"
          : "every streak badge unlocked"
      ],
      [
        "ETA",
        m.finish ? shortDate(m.finish.date) : "—",
        m.finish ? Math.max(0.05, 1 - Math.min(1, m.finish.days / 60)) : 0,
        m.finish
          ? m.finish.name + ": remaining minutes ÷ your 14-day pace on it (" + m.finish.days + " days)"
          : "no playlist is moving yet"
      ]
    ];
  }
  function buildVitals() {
    var wrap = card("vitals", "Vitals", "Focus score");
    var G = gauges();
    var top = el("div", "vitals__top");
    var face = el("div", "vitals__face");
    var arc = G ? G.segArc({ size: 150, segments: 32 }) : null;
    if (arc) face.appendChild(arc.node);
    var mid = el("div", "vitals__mid");
    var score = el("p", "vitals__score", "0");
    mid.appendChild(score);
    mid.appendChild(el("p", "vitals__cap", "/ 100 FOCUS"));
    face.appendChild(mid);
    top.appendChild(face);
    var radar = G
      ? G.radar(
          [
            { label: "", value: 0 },
            { label: "", value: 0 },
            { label: "", value: 0 },
            { label: "", value: 0 },
            { label: "", value: 0 }
          ],
          170
        )
      : null;
    if (radar) {
      var rbox = el("div", "vitals__radar");
      rbox.appendChild(radar.node);
      top.appendChild(rbox);
    }
    wrap.appendChild(top);
    var grid = el("div", "readouts");
    wrap.appendChild(grid);
    var COMPACT = ["CONSISTENCY", "DAILY AVG", "DEEP WORK", "MOMENTUM", "COMPLETION", "ETA"];
    var cells = {};
    COMPACT.forEach(function (k) {
      var r = readout(k);
      cells[k] = r;
      grid.appendChild(r.node);
    });
    var numTicker = G ? G.ticker(score) : null;

    var last = null;
    function refresh() {
      var m = metrics();
      if (!m) return;
      last = m;
      if (numTicker) numTicker.set(String(m.focus));
      else score.textContent = String(m.focus);
      if (arc) arc.set(m.focus / 100);
      if (radar) radar.set(m.habits);
      vitalRows(m).forEach(function (row) {
        if (cells[row[0]]) cells[row[0]].set(row[1], row[2]);
      });
    }
    function renderFull(container) {
      var m = last || metrics();
      var box = el("div", "dfull dfull--vitals");
      if (!m) {
        box.appendChild(emptyNote("No data yet."));
        container.appendChild(box);
        return {
          destroy: function () {
            box.remove();
          }
        };
      }
      var head = el("div", "vitals__full-top");
      if (G) {
        var big = G.segArc({ size: 220, segments: 40, value: m.focus / 100 });
        var f = el("div", "vitals__face vitals__face--lg");
        f.appendChild(big.node);
        var mm = el("div", "vitals__mid");
        mm.appendChild(el("p", "vitals__score", String(m.focus)));
        mm.appendChild(el("p", "vitals__cap", "/ 100 FOCUS"));
        f.appendChild(mm);
        head.appendChild(f);
        var rb = el("div", "vitals__radar vitals__radar--lg");
        rb.appendChild(G.radar(m.habits, 260).node);
        head.appendChild(rb);
        var cb = el("div", "vitals__clock");
        cb.appendChild(G.clock24(m.hours, 220).node);
        cb.appendChild(el("p", "readout__l", "24H STUDY CLOCK"));
        head.appendChild(cb);
      }
      box.appendChild(head);
      box.appendChild(
        el(
          "p",
          "dash__hint muted",
          "Focus score = 40% consistency (active days / 30) + 35% goals on track (or weekly pace) + 25% streak (days / 30)."
        )
      );
      var list = el("div", "readouts readouts--full");
      vitalRows(m).forEach(function (row) {
        var r = readout(row[0]);
        r.set(row[1], row[2]);
        r.node.appendChild(el("p", "readout__why", row[3]));
        list.appendChild(r.node);
      });
      box.appendChild(list);
      container.appendChild(box);
      return {
        destroy: function () {
          box.remove();
        }
      };
    }
    return { id: "vitals", node: wrap, title: "Vitals", refresh: refresh, renderFull: renderFull };
  }

  // ===== 6. The dashboard screen =====
  // `?open=<id>` in the query string (e.g. ?open=time) opens a card right after mounting.
  function openParam() {
    var m = /[?&]open=([a-z]+)/i.exec(
      safe(function () {
        return location.search;
      }, "")
    );
    return m ? m[1].toLowerCase() : null;
  }
  /**
   * Draws the dashboard into `container` and keeps it live (charts re-draw when activity, goals or
   * playlists change).
   * @param {HTMLElement} container the #view element
   * @returns {{destroy: function(): void}} stops every timer, listener and effect and removes the screen
   */
  function mount(container) {
    var alive = true;
    var tot = totals();
    var root = el("div", "dash");
    // the backdrop behind the glass: motion.js draws a living aurora, otherwise a still gradient from CSS
    var bg = el("div", "dash__bg");
    bg.setAttribute("aria-hidden", "true");
    root.appendChild(bg);
    var m = motion();
    var bgHandle =
      m && typeof m.aurora === "function"
        ? safe(function () {
            return m.aurora(bg);
          }, null)
        : null;
    if (bgHandle) bg.classList.add("is-live");
    var header = buildHeader(tot, logLines);
    root.appendChild(header.node);

    // HUD layout (css grid areas): left column | the core + vitals in the middle | right column,
    // then a bottom row. The core is listed as a card too, so the neural layer can join it to the others.
    var grid = el("div", "dash__grid");
    var cards = [];
    function openById(id) {
      var c = cards.filter(function (x) {
        return x.id === id;
      })[0];
      if (!c) return;
      // the streak view attaches expand to its own inner card, so click that element (clicks don't bubble down)
      if (c.id === "streak")
        (c.node.querySelector(".xp-card") || c.node).dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true })
        );
      else if (c.node.classList.contains("is-expandable")) openCard(c);
    }
    cards = [
      buildCore(openById),
      buildStreak(),
      buildToday(),
      buildGoals(),
      buildVitals(),
      buildTimeStudied(function () {
        /* the day's sessions show inside the Time panel itself */
      }),
      buildBestTime(),
      buildCourses(),
      buildSplit(),
      buildContinue(),
      buildBoard()
    ];
    cards.forEach(function (c) {
      grid.appendChild(c.node);
    });
    root.appendChild(grid);
    container.appendChild(root);

    function refreshAll() {
      if (!alive) return;
      tot = totals();
      var focus = root.querySelector(".dash__focus");
      if (focus) focus.textContent = focusLine(tot);
      cards.forEach(function (c) {
        if (c.refresh)
          safe(function () {
            c.refresh(tot);
          });
      });
    }
    refreshAll();

    // expand + hover effects (all optional), then the staggered reveal
    var effects = []; // motion.js handles, destroyed with the screen
    if (bg.classList.contains("is-live")) effects.push(bgHandle);
    cards.forEach(function (c) {
      if (c.id !== "streak" && c.id !== "core") {
        attachExpand(c);
        effects = effects.concat(decorate(c.node, 2));
      }
    });
    if (m && typeof m.reveal === "function") {
      var rv = safe(function () {
        return m.reveal(grid);
      }, null);
      if (rv) {
        effects.push(rv);
        grid.classList.add("is-motion");
      } // with motion.js present it plays the entrance instead of the CSS one
    }

    // ----- HUD and neural layer -----
    // Backdrop (hex grid + perspective floor), HUD frames on every card, and the neural canvas whose threads
    // join the cards. All handles go into `effects`, so destroy() below cleans them up.
    if (AQ.hud) {
      effects.push(
        safe(function () {
          return AQ.hud.backdrop(root);
        }, null)
      );
      cards.forEach(function (c) {
        effects.push(
          safe(function () {
            return AQ.hud.frame(c.node);
          }, null)
        );
      });
    }
    if (AQ.neural) {
      effects.push(
        safe(function () {
          return AQ.neural.mount(grid, {
            cards: cards.map(function (c) {
              return { id: c.id, el: c.node, accent: ACCENT[c.id] };
            })
          });
        }, null)
      );
    }

    // ?open=<id>: open that card once the reveal has settled
    var wanted = openParam(),
      openTimer = 0;
    if (wanted) {
      openTimer = setTimeout(
        function () {
          if (!alive) return;
          openById(wanted);
        },
        reducedMotion() ? 50 : 700
      );
    }

    // re-draw when activity or playlists change (charts animate in place)
    var unsubActivity = subscribeActivity(refreshAll);
    var unsubGoals = safe(function () {
      return AQ.goals && AQ.goals.subscribe ? AQ.goals.subscribe(refreshAll) : null;
    }, null);
    var storeTimer = 0;
    function onStore() {
      clearTimeout(storeTimer);
      storeTimer = setTimeout(refreshAll, 50);
    }
    AQ.store.subscribe(onStore); // store.subscribe has no unsubscribe; `alive` makes it a no-op after destroy

    return {
      destroy: function () {
        alive = false;
        clearTimeout(storeTimer);
        clearTimeout(openTimer);
        safe(header.destroy); // the live clock + system log timers
        if (typeof unsubActivity === "function") safe(unsubActivity);
        if (typeof unsubGoals === "function") safe(unsubGoals);
        if (AQ.expand && typeof AQ.expand.closeAll === "function")
          safe(function () {
            AQ.expand.closeAll();
          });
        effects.forEach(function (h) {
          if (h && typeof h.destroy === "function")
            safe(function () {
              h.destroy();
            });
        });
        cards.forEach(function (c) {
          if (c.handle && c.handle.destroy)
            safe(function () {
              c.handle.destroy();
            });
          if (c.destroy) safe(c.destroy);
        });
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  }

  // ===== 7. The generic "Coming soon" screen (used by the AI route) =====
  /**
   * Draws a "Coming soon" placeholder with a link back to the dashboard.
   * @param {HTMLElement} container
   * @param {{title?: string, text?: string}} [opts]
   * @returns {{destroy: function(): void}}
   */
  function mountSoon(container, opts) {
    opts = opts || {};
    var box = el("div", "empty soon");
    box.appendChild(el("p", "dash__tag", "Coming soon"));
    var h1 = el("h1", "empty__title", opts.title || "Coming soon");
    h1.tabIndex = -1;
    h1.setAttribute("data-focus-fallback", "");
    box.appendChild(h1);
    box.appendChild(el("p", "muted", opts.text || "We are still building this."));
    var a = el("a", "btn btn--ghost btn--sm", "Back to dashboard");
    a.href = "#/dashboard";
    box.appendChild(a);
    container.appendChild(box);
    return {
      destroy: function () {
        if (box.parentNode) box.parentNode.removeChild(box);
      }
    };
  }

  // ===== 8. Public API =====
  AQ.dashboardView = { mount: mount };
  AQ.comingSoonView = { mount: mountSoon };
})();

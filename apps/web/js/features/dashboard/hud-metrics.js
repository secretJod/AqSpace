/* =====================================================================================================
   What this file does:
     Computes the "more values on the table" numbers of the HUD dashboard in ONE place:
     focus score, daily average, consistency, longest session, deep-work sessions, pace vs goal,
     projected minutes this week, momentum, best weekday, peak hour, lectures watched, completion %,
     notes per lecture, next streak milestone, estimated finish date, and the 5 habit scores of the
     radar chart. Pure reads: nothing here writes to storage or touches the DOM.

   How it fits:
     Loaded after activity-log.js / goals.js / streak.js and before dashboard.js. dashboard.js calls
     `AQ.hudMetrics.compute()` on every refresh and shows the result as HUD readouts.
     Every source (AQ.activity, AQ.store, AQ.goals, AQ.streak) is optional: a missing one gives zeros.

   Start reading at:
     `compute()` in section 4, then the single-value helpers in section 3.
   ===================================================================================================== */
(function () {
  "use strict";
  var DAY = 86400000;
  var DEEP_WORK_MIN = 25; // a session this long (or longer) counts as deep work
  var WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  // ===== 1. Small helpers =====
  function safe(fn, fallback) {
    try {
      var r = fn();
      return r == null ? fallback : r;
    } catch (e) {
      return fallback;
    }
  }
  function clamp01(x) {
    return Math.max(0, Math.min(1, +x || 0));
  }
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
    return new Date(startOfDay(new Date()).getTime() - n * DAY);
  }
  function sum(list) {
    var s = 0;
    list.forEach(function (v) {
      s += +v || 0;
    });
    return s;
  }
  // Monday = 0 ... Sunday = 6 (the activity log and goals use the same week)
  function weekdayIdx(d) {
    return (d.getDay() + 6) % 7;
  }

  // ===== 2. Guarded data access =====
  function activity() {
    return window.AQ && AQ.activity ? AQ.activity : null;
  }
  function dayRows(days) {
    var a = activity(),
      rows = a
        ? safe(function () {
            return a.minutesByDay(days);
          }, null)
        : null;
    if (Array.isArray(rows)) return rows;
    // fallback: the streak's day records (minutes only)
    var recs = safe(function () {
        return AQ.streak.days();
      }, {}),
      out = [];
    for (var i = days - 1; i >= 0; i--) {
      var k = dayKey(daysAgo(i));
      out.push({ date: k, minutes: recs[k] ? +recs[k].minutes || 0 : 0 });
    }
    return out;
  }
  function studySessions() {
    var a = activity(),
      list = a
        ? safe(function () {
            return a.recent(5000);
          }, [])
        : [];
    return (Array.isArray(list) ? list : []).filter(function (s) {
      return s && s.kind !== "playlist";
    });
  }
  function totals() {
    var a = activity();
    return (
      (a &&
        safe(function () {
          return a.totals();
        }, null)) || { today: 0, week: 0, lastWeek: 0, month: 0, allTime: 0 }
    );
  }
  function hours() {
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
  function heat() {
    var a = activity(),
      m = a
        ? safe(function () {
            return a.weekdayHeat();
          }, null)
        : null;
    return Array.isArray(m) && m.length === 7 ? m : null;
  }
  function goalRows() {
    return safe(function () {
      var G = AQ.goals;
      return G.list()
        .map(function (g) {
          return { goal: g, pr: G.progress(g) };
        })
        .filter(function (x) {
          return x.pr;
        });
    }, []);
  }
  function streakStats() {
    return safe(function () {
      return AQ.streak.stats();
    }, null);
  }

  // ===== 3. One value each =====
  // Linear forecast for this calendar week: minutes so far / days elapsed (fractional, Mon 00:00 -> now) x 7.
  function projectedWeek(weekMinutes) {
    var now = new Date(),
      elapsed = weekdayIdx(now) + (now.getHours() + now.getMinutes() / 60) / 24;
    return Math.round((weekMinutes / Math.max(0.5, elapsed)) * 7);
  }
  // The weekly minute target: a "minutes per week" goal, or a "per day" goal x 7; null without one.
  function weeklyTarget(goals) {
    var week = 0,
      day = 0;
    goals.forEach(function (x) {
      if (x.goal.type !== "minutes") return;
      if (x.goal.period === "day") day = Math.max(day, +x.goal.target || 0);
      else week = Math.max(week, +x.goal.target || 0);
    });
    return week || (day ? day * 7 : null);
  }
  // Videos across every playlist (each video counted once): { done, total, touched }
  function lectureCounts() {
    return safe(
      function () {
        var S = AQ.store,
          seen = {},
          out = { done: 0, total: 0, touched: 0, watchedSec: 0, totalSec: 0 };
        S.all().forEach(function (p) {
          p.videos.forEach(function (v) {
            if (seen[v.id]) return;
            seen[v.id] = 1;
            out.total++;
            if (S.isWatched(v.id)) out.done++;
            var dur = AQ.util.parseDuration(v.duration) || 0;
            var w = S.watchInfo(v.id, dur);
            if (w && (w.updated || w.pos >= 1)) out.touched++;
            // time-based completion: a finished video counts fully, a started one by its position
            out.totalSec += dur;
            out.watchedSec += S.isWatched(v.id) ? dur : Math.min(dur, (w && w.pos) || 0);
          });
        });
        return out;
      },
      { done: 0, total: 0, touched: 0, watchedSec: 0, totalSec: 0 }
    );
  }
  // Minutes per day on one playlist over the last `days` days (activity sessions).
  function playlistRate(pid, sessions, days) {
    var from = daysAgo(days - 1).getTime(),
      min = 0;
    sessions.forEach(function (s) {
      if (s.playlistId === pid && new Date(s.start).getTime() >= from) min += +s.minutes || 0;
    });
    return min / days;
  }
  // Estimated finish date of the closest playlist goal (or, without such a goal, the furthest playlist).
  // remaining minutes / minutes-per-day on that playlist over the last 14 days. null when nothing moves.
  function finishEstimate(goals, sessions) {
    var candidates = [];
    goals.forEach(function (x) {
      if (x.goal.type === "playlist" && x.pr.status !== "done" && !x.pr.missing)
        candidates.push({ id: x.goal.playlistId, name: x.goal.title, left: Math.max(0, x.pr.target - x.pr.current) });
    });
    if (!candidates.length)
      safe(function () {
        AQ.store.all().forEach(function (p) {
          var pr = AQ.store.progress(p);
          if (pr.pct > 0 && pr.pct < 100)
            candidates.push({ id: p.id, name: p.name, left: Math.max(0, (pr.totalSec - pr.watchedSec) / 60) });
        });
      });
    var best = null;
    candidates.forEach(function (c) {
      var rate = playlistRate(c.id, sessions, 14);
      if (rate <= 0) return;
      var days = Math.ceil(c.left / rate);
      if (!best || days < best.days)
        best = { name: c.name, days: days, date: new Date(startOfDay(new Date()).getTime() + days * DAY) };
    });
    return best;
  }
  function nextMilestone(current) {
    var list = safe(function () {
      return AQ.streakView.MILESTONES;
    }, null) || [
      { n: 7, name: "Spark" },
      { n: 30, name: "Blaze" },
      { n: 100, name: "Inferno" },
      { n: 365, name: "Supernova" }
    ];
    for (var i = 0; i < list.length; i++)
      if (list[i].n > current) return { name: list[i].name, days: list[i].n - current, at: list[i].n };
    return null;
  }

  // ===== 4. Everything at once =====
  function compute() {
    var tot = totals();
    var d30 = dayRows(30),
      d14 = d30.slice(-14);
    var min30 = d30.map(function (r) {
      return +r.minutes || 0;
    });
    var activeDays = min30.filter(function (m) {
      return m > 0;
    }).length;
    var consistency = Math.round((100 * activeDays) / 30);
    var dailyAvg = Math.round(sum(min30) / 30);

    var sessions = studySessions();
    var from30 = daysAgo(29).getTime();
    var recent30 = sessions.filter(function (s) {
      return new Date(s.start).getTime() >= from30;
    });
    var longest = 0;
    sessions.forEach(function (s) {
      longest = Math.max(longest, +s.minutes || 0);
    });
    var deep = recent30.filter(function (s) {
      return (+s.minutes || 0) >= DEEP_WORK_MIN;
    }).length;

    // momentum: the last 7 days against the 7 before them
    var last7 = sum(
        d14.slice(-7).map(function (r) {
          return r.minutes;
        })
      ),
      prev7 = sum(
        d14.slice(0, 7).map(function (r) {
          return r.minutes;
        })
      );
    var momentum = prev7 ? Math.round((100 * (last7 - prev7)) / prev7) : last7 ? 100 : 0;

    var projected = projectedWeek(tot.week);
    var goals = goalRows();
    var target = weeklyTarget(goals);
    var paceBase = target || tot.lastWeek || 0; // without a minutes goal: compare with last week
    var pace = paceBase ? Math.round((100 * projected) / paceBase) : 0;

    var open = goals.filter(function (x) {
      return x.pr.status !== "done";
    });
    var onTrack = open.filter(function (x) {
      return x.pr.status !== "behind";
    }).length;
    var goalShare = goals.length ? (open.length ? onTrack / open.length : 1) : clamp01(pace / 100);

    var h = hours(),
      peak = -1;
    h.forEach(function (v, i) {
      if (v > 0 && (peak < 0 || v > h[peak])) peak = i;
    });
    var m = heat(),
      bestDay = -1;
    if (m)
      m.forEach(function (row, i) {
        var s = sum(row);
        if (s > 0 && (bestDay < 0 || s > sum(m[bestDay]))) bestDay = i;
      });

    var lec = lectureCounts();
    var notesTotal = sessions.filter(function (s) {
      return s.kind === "notes";
    }).length;
    var notesPerLecture = lec.touched ? Math.round((100 * notesTotal) / lec.touched) / 100 : 0;

    var st = streakStats(),
      streak = st ? st.current || 0 : 0;
    var milestone = nextMilestone(streak);

    // the five habits of the radar (0..1 each)
    var habits = [
      { key: "consistency", label: "Consistency", value: clamp01(activeDays / 30) },
      { key: "volume", label: "Volume", value: clamp01(dailyAvg / 60) }, // 60 min a day = full
      { key: "depth", label: "Depth", value: recent30.length ? clamp01(deep / recent30.length) : 0 },
      { key: "notes", label: "Notes", value: clamp01(notesPerLecture) }, // 1 note per lecture = full
      { key: "goals", label: "Goals", value: clamp01(goalShare) }
    ];

    // focus score: a weighted mix of consistency, goal pace and streak (each 0..1), times 100
    var focus = Math.round(
      100 *
        (0.4 * clamp01(activeDays / 30) +
          0.35 * clamp01(goals.length ? goalShare : pace / 100) +
          0.25 * clamp01(streak / 30))
    );

    return {
      totals: tot,
      focus: focus,
      dailyAvg: dailyAvg,
      consistency: consistency,
      activeDays: activeDays,
      longest: Math.round(longest),
      deepWork: deep,
      sessions30: recent30.length,
      pace: pace,
      paceAgainst: target ? "goal" : "last week",
      weeklyTarget: target,
      projected: projected,
      momentum: momentum,
      last7: Math.round(last7),
      prev7: Math.round(prev7),
      peakHour: peak,
      bestWeekday: bestDay >= 0 ? WEEKDAYS[bestDay] : null,
      hours: h,
      lecturesWatched: lec.done,
      lecturesTotal: lec.total,
      completion: lec.totalSec
        ? Math.round((100 * lec.watchedSec) / lec.totalSec)
        : lec.total
          ? Math.round((100 * lec.done) / lec.total)
          : 0,
      notesTotal: notesTotal,
      notesPerLecture: notesPerLecture,
      streak: streak,
      milestone: milestone,
      finish: finishEstimate(goals, sessions),
      goalsOpen: open.length,
      goalsOnTrack: onTrack,
      goalsTotal: goals.length,
      habits: habits,
      spark14: d14.map(function (r) {
        return Math.round(+r.minutes || 0);
      })
    };
  }

  AQ.hudMetrics = { compute: compute, DEEP_WORK_MIN: DEEP_WORK_MIN };
})();

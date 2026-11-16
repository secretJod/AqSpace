/* =====================================================================================================
   What this file does:
     Learning goals: the data (`AQ.goals`, localStorage) + how far along each goal is, and the goals card
     on the dashboard (`AQ.goalsView`) with progress rings, status chips, the add/edit form and a small
     confetti burst when a goal completes. Styles: css/goals.css (classes start with `gl-`).

   How it fits:
     Loaded after activity-log.js (minutes / notes counts) and store.js (playlist completion); the form
     uses AQ.dialog when it exists, otherwise an inline panel. dashboard.js mounts the card with
     `AQ.goalsView.mount(container) -> { destroy() }`.

   Start reading at:
     The goal shape below, `progress()` in PART 1 (section 4), then `mount()` in PART 2.
   ===================================================================================================== */

/* AQspace - goals.
   localStorage key `aq.goals.v1` = JSON array:
   Goal = { id, type: "playlist"|"minutes"|"notes"|"checklist", title, target (number), deadline? ("YYYY-MM-DD"),
            created (ISO), done (bool), playlistId? (type playlist), period? ("day"|"week", type minutes),
            items? ([{ text, done }], type checklist) }
   "minutes" and "notes" goals repeat every day / week, so their `done` is computed, never stored. */
window.AQ = window.AQ || {};
(function (AQ) {
  "use strict";

  // ===== PART 1: the data (AQ.goals) - no DOM code until PART 2 =====

  var KEY = "aq.goals.v1";
  var TYPES = ["playlist", "minutes", "notes", "checklist"];
  var LIMITS = { goals: 50, title: 80, items: 30, item: 120, target: 100000 };
  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  var goals = [];
  var storageOk = true;
  var listeners = [];

  // ===== 1. date helpers (local days) =====
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function dayKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function dateOf(key) { var p = key.split("-"); return new Date(+p[0], p[1] - 1, +p[2]); }
  function today() { var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function weekdayIdx(d) { return (d.getDay() + 6) % 7; }           // Mon = 0
  function shortDate(key) { var d = dateOf(key); return MON[d.getMonth()] + " " + d.getDate(); }
  /* whole days from today until the deadline day (0 = today, negative = passed) */
  function daysUntil(key) { return Math.round((dateOf(key) - today()) / 86400000); }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  // ===== 2. persistence =====
  function str(x, max) { return typeof x === "string" ? x.trim().slice(0, max) : ""; }
  function cleanGoal(raw) {
    if (!raw || typeof raw !== "object" || TYPES.indexOf(raw.type) < 0) return null;
    var title = str(raw.title, LIMITS.title);
    if (!title) return null;
    var g = {
      id: typeof raw.id === "string" && raw.id ? raw.id.slice(0, 24) : newId(),
      type: raw.type, title: title,
      target: Math.min(LIMITS.target, Math.max(0, Math.floor(+raw.target || 0))),
      created: typeof raw.created === "string" && !isNaN(Date.parse(raw.created)) ? raw.created : new Date().toISOString(),
      done: !!raw.done
    };
    if (typeof raw.deadline === "string" && DAY_RE.test(raw.deadline)) g.deadline = raw.deadline;
    if (g.type === "playlist") g.playlistId = str(raw.playlistId, 48);
    if (g.type === "minutes") g.period = raw.period === "day" ? "day" : "week";
    if (g.type === "notes") g.period = "week";
    if (g.type === "checklist") {
      g.items = [];
      (Array.isArray(raw.items) ? raw.items : []).slice(0, LIMITS.items).forEach(function (it) {
        var text = str(it && it.text, LIMITS.item);
        if (text) g.items.push({ text: text, done: !!(it && it.done) });
      });
      g.target = g.items.length;
    }
    return g;
  }
  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { storageOk = false; }
    if (!raw) return;
    try { var arr = JSON.parse(raw); goals = []; (Array.isArray(arr) ? arr : []).forEach(function (r) { var g = cleanGoal(r); if (g) goals.push(g); }); }
    catch (e) { goals = []; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(goals)); storageOk = true; }
    catch (e) { storageOk = false; }
  }
  function emit(evt) { listeners.slice().forEach(function (fn) { try { fn(evt || {}); } catch (e) { /* isolate listeners */ } }); }
  function newId() { return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ===== 3. CRUD =====
  function list() { return goals.slice(); }
  function get(id) { for (var i = 0; i < goals.length; i++) if (goals[i].id === id) return goals[i]; return null; }
  /** Add a goal from form data; returns the stored goal or null when invalid / too many. */
  function add(data) {
    if (goals.length >= LIMITS.goals) return null;
    var g = cleanGoal(Object.assign({}, data, { id: newId(), created: new Date().toISOString(), done: false }));
    if (!g) return null;
    goals.push(g); save(); emit({ type: "add", id: g.id });
    return g;
  }
  function update(id, patch) {
    var cur = get(id); if (!cur) return null;
    var g = cleanGoal(Object.assign({}, cur, patch, { id: cur.id, created: cur.created }));
    if (!g) return null;
    goals[goals.indexOf(cur)] = g; save(); emit({ type: "update", id: id });
    return g;
  }
  function remove(id) {
    var cur = get(id); if (!cur) return false;
    goals.splice(goals.indexOf(cur), 1); save(); emit({ type: "remove", id: id });
    return true;
  }
  function setDone(id, done) { var g = get(id); if (!g) return false; g.done = !!done; save(); emit({ type: "update", id: id }); return true; }
  /** Tick / untick one checklist item; the goal is done when every item is. */
  function toggleItem(id, index, done) {
    var g = get(id); if (!g || g.type !== "checklist" || !g.items[index]) return false;
    g.items[index].done = done == null ? !g.items[index].done : !!done;
    g.done = g.items.every(function (it) { return it.done; });
    save(); emit({ type: "update", id: id });
    return true;
  }

  // ===== 4. progress =====
  function minutesText(m) { m = Math.round(m); return m >= 90 ? (Math.floor(m / 60) + " hr" + (m % 60 ? " " + (m % 60) + " min" : "")) : m + " min"; }
  function perDay(minutes, days) { return minutesText(Math.ceil(minutes / Math.max(1, days))) + "/day"; }
  /* "ahead" / "on track" / "behind" by comparing done share with the share of the time that has passed */
  function compare(pct, expectedFraction) {
    var e = expectedFraction * 100;
    return pct >= e + 10 ? "ahead" : pct < e - 10 ? "behind" : "on track";
  }
  /* share of the time between `created` and the deadline that is already gone (null without a deadline) */
  function timeFraction(g) {
    if (!g.deadline) return null;
    var start = Date.parse(g.created), end = dateOf(g.deadline).getTime() + 86400000, now = Date.now();
    return end <= start ? 1 : clamp01((now - start) / (end - start));
  }

  function progressPlaylist(g) {
    var S = AQ.store, p = S && S.get ? S.get(g.playlistId) : null;
    if (!p) return { percent: 0, status: "behind", pace: "Playlist no longer exists", current: 0, target: 0, unit: "min", missing: true };
    var pr = S.progress(p), pct = pr.pct, remaining = Math.max(0, (pr.totalSec - pr.watchedSec) / 60);
    var done = g.done || pct >= 100 || (pr.total > 0 && pr.done >= pr.total);
    var out = { percent: done ? 100 : pct, current: Math.round(pr.watchedSec / 60), target: Math.round(pr.totalSec / 60), unit: "min",
      detail: pr.done + " of " + pr.total + " videos" };
    if (done) { out.status = "done"; out.pace = "Finished"; return out; }
    if (!g.deadline) { out.status = "on track"; out.pace = (pr.totalSec ? minutesText(remaining) : (pr.total - pr.done) + " videos") + " left"; return out; }
    var days = daysUntil(g.deadline);
    out.status = days < 0 ? "behind" : compare(pct, timeFraction(g));
    out.pace = days < 0 ? "Deadline passed" + (pr.totalSec ? " - " + minutesText(remaining) + " left" : "")
      : (pr.totalSec ? perDay(remaining, days + 1) : Math.ceil((pr.total - pr.done) / (days + 1)) + " videos/day") + " to finish by " + shortDate(g.deadline);
    return out;
  }
  function progressMinutes(g) {
    var A = AQ.activity, t = A && A.totals ? A.totals() : { today: 0, week: 0 };
    var cur = g.period === "day" ? t.today : t.week, target = g.target || 1;
    var pct = Math.min(100, Math.round(100 * cur / target)), left = Math.max(0, target - cur);
    var out = { percent: pct, current: Math.round(cur), target: target, unit: "min", detail: Math.round(cur) + " of " + target + " min " + (g.period === "day" ? "today" : "this week") };
    if (cur >= target) { out.status = "done"; out.pace = g.period === "day" ? "Target reached today" : "Weekly target reached"; return out; }
    var now = new Date();
    if (g.period === "day") {
      out.status = compare(pct, clamp01((now.getHours() - 7) / 15));           // a waking day: 7:00 -> 22:00
      out.pace = minutesText(left) + " more today";
    } else {
      var daysLeft = 7 - weekdayIdx(now);                                        // today included
      out.status = compare(pct, (weekdayIdx(now) + now.getHours() / 24) / 7);
      out.pace = perDay(left, daysLeft) + " for the rest of the week";
    }
    return out;
  }
  function progressNotes(g) {
    var A = AQ.activity, now = new Date(), monday = addDays(today(), -weekdayIdx(now));
    var cur = A && A.count ? A.count("notes", { from: monday }) : 0, target = g.target || 1;
    var pct = Math.min(100, Math.round(100 * cur / target));
    var out = { percent: pct, current: cur, target: target, unit: "notes", detail: cur + " of " + target + " notes this week" };
    if (cur >= target) { out.status = "done"; out.pace = "Weekly target reached"; return out; }
    out.status = compare(pct, (weekdayIdx(now) + now.getHours() / 24) / 7);
    var left = target - cur;
    out.pace = left + (left === 1 ? " more note" : " more notes") + " this week";
    return out;
  }
  function progressChecklist(g) {
    var total = g.items.length, done = g.items.filter(function (it) { return it.done; }).length;
    var pct = total ? Math.round(100 * done / total) : 0, left = total - done;
    var out = { percent: pct, current: done, target: total, unit: "items", detail: done + " of " + total + " items" };
    if (g.done || (total && done === total)) { out.status = "done"; out.percent = 100; out.pace = "All done"; return out; }
    if (!g.deadline) { out.status = "on track"; out.pace = left + (left === 1 ? " item" : " items") + " left"; return out; }
    var days = daysUntil(g.deadline);
    out.status = days < 0 ? "behind" : compare(pct, timeFraction(g));
    out.pace = days < 0 ? "Deadline passed - " + left + " left"
      : left + " left - " + (days < 1 ? "all today" : Math.ceil(left / (days + 1)) + "/day") + " to finish by " + shortDate(g.deadline);
    return out;
  }
  /** { percent 0-100, status "on track"|"behind"|"ahead"|"done", pace (sentence), current, target, unit, detail } */
  function progress(g) {
    if (!g) return null;
    var out = g.type === "playlist" ? progressPlaylist(g) : g.type === "minutes" ? progressMinutes(g)
      : g.type === "notes" ? progressNotes(g) : progressChecklist(g);
    if (g.done && out.status !== "done") { out.status = "done"; out.percent = 100; out.pace = "Marked done"; }
    return out;
  }
  function subscribe(fn) {
    if (typeof fn !== "function") return function () {};
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }

  // only the user's own goals (the old ?demo=dashboard sample goals are gone; see js/core/demo-cleanup.js)
  load();
  try { window.addEventListener("storage", function (e) { if (e.key === KEY) { load(); emit({ type: "sync" }); } }); } catch (e) { /* no window */ }

  AQ.goals = {
    KEY: KEY, TYPES: TYPES, LIMITS: LIMITS,
    list: list, get: get, add: add, update: update, remove: remove, setDone: setDone, toggleItem: toggleItem,
    progress: progress, subscribe: subscribe, storageOk: function () { return storageOk; }
  };

  // =====================================================================================
  // ===== PART 2: the view (AQ.goalsView) - everything below draws the goals card =====
  // =====================================================================================
  var SVG_NS = "http://www.w3.org/2000/svg";
  var RING_R = 22, RING_C = 2 * Math.PI * RING_R;
  var TYPE_LABEL = { playlist: "Finish a playlist", minutes: "Study minutes", notes: "Notes per week", checklist: "Checklist" };
  var STATUS_LABEL = { "on track": "On track", behind: "Behind", ahead: "Ahead", done: "Done" };

  function el(tag, cls, text) { return AQ.util.el(tag, cls, text); }
  function svg(tag, attrs) { var n = document.createElementNS(SVG_NS, tag); for (var a in attrs) n.setAttribute(a, attrs[a]); return n; }
  function iconBtn(name, label, cls) {
    var b = AQ.util.button("", { cls: "iconbtn " + (cls || ""), icon: name, aria: label, title: label });
    return b;
  }
  /* util.js has no check mark icon, so this one is drawn here (same look as the others) */
  function checkIcon() {
    var s = svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false", "class": "icon" });
    s.appendChild(svg("path", { d: "M5 13l4 4L19 7", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" }));
    return s;
  }
  function reducedMotion() { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } }
  function statusClass(s) { return "gl--" + s.replace(" ", "-"); }

  // ===== 5. the progress ring (SVG, animated with stroke-dashoffset) =====
  function ring(pct, fromPct) {
    var box = el("div", "gl-ring");
    var s = svg("svg", { viewBox: "0 0 56 56", "aria-hidden": "true", focusable: "false", "class": "gl-ring__svg" });
    s.appendChild(svg("circle", { "class": "gl-ring__track", cx: 28, cy: 28, r: RING_R }));
    var bar = svg("circle", { "class": "gl-ring__bar", cx: 28, cy: 28, r: RING_R, "stroke-dasharray": RING_C,
      "stroke-dashoffset": RING_C * (1 - clamp01((fromPct == null ? 0 : fromPct) / 100)) });
    s.appendChild(bar);
    box.appendChild(s);
    box.appendChild(el("span", "gl-ring__pct", Math.round(pct) + "%"));
    // next frame: move to the real value, the CSS transition does the sweep
    requestAnimationFrame(function () { requestAnimationFrame(function () { bar.setAttribute("stroke-dashoffset", RING_C * (1 - clamp01(pct / 100))); }); });
    return box;
  }

  // ===== 6. confetti =====
  function confetti(host) {
    if (reducedMotion()) { host.classList.add("gl-pop-static"); setTimeout(function () { host.classList.remove("gl-pop-static"); }, 1200); return; }
    var b = el("div", "gl-confetti"); b.setAttribute("aria-hidden", "true");
    for (var i = 0; i < 22; i++) {
      var p = el("i");
      p.style.setProperty("--a", (i * (360 / 22) + Math.random() * 12) + "deg");
      p.style.setProperty("--r", (44 + Math.random() * 40) + "px");
      p.style.setProperty("--d", (Math.random() * 140) + "ms");
      p.style.setProperty("--h", Math.floor(Math.random() * 360));
      b.appendChild(p);
    }
    host.appendChild(b);
    host.classList.add("gl-pop");
    setTimeout(function () { b.remove(); host.classList.remove("gl-pop"); }, 1300);
  }

  // ===== 7. the add / edit form =====
  function field(labelText, input, id) {
    var f = el("div", "field");
    var l = el("label", null, labelText); l.htmlFor = id; input.id = id;
    f.appendChild(l); f.appendChild(input);
    return f;
  }
  function option(sel, value, text, selected) { var o = el("option", null, text); o.value = value; if (selected) o.selected = true; sel.appendChild(o); return o; }
  /** Builds the form element. onSave(data) is called with clean form data; onCancel() closes. */
  function buildForm(goal, onSave, onCancel) {
    var uid = "gl-f-" + Math.random().toString(36).slice(2, 7);
    var form = el("form", "form gl-form"); form.noValidate = true;
    var type = el("select", "gl-select");
    TYPES.forEach(function (t) { option(type, t, TYPE_LABEL[t], goal ? goal.type === t : t === "minutes"); });
    if (goal) type.disabled = true;                      // the type of an existing goal cannot change
    var title = el("input"); title.type = "text"; title.maxLength = LIMITS.title; title.required = true; title.value = goal ? goal.title : "";
    title.placeholder = "e.g. Finish calculus before exams";
    var playlist = el("select", "gl-select");
    var pls = AQ.store && AQ.store.all ? AQ.store.all() : [];
    option(playlist, "", pls.length ? "Choose a playlist" : "No playlists yet", true);
    pls.forEach(function (p) { option(playlist, p.id, p.name, goal && goal.playlistId === p.id); });
    var target = el("input"); target.type = "number"; target.min = "1"; target.max = String(LIMITS.target); target.step = "1";
    target.value = goal && goal.target ? String(goal.target) : "";
    var period = el("select", "gl-select");
    option(period, "day", "per day", goal && goal.period === "day"); option(period, "week", "per week", !goal || goal.period !== "day");
    var deadline = el("input"); deadline.type = "date"; deadline.value = goal && goal.deadline ? goal.deadline : "";
    var items = el("textarea"); items.rows = 4; items.placeholder = "One item per line";
    items.value = goal && goal.items ? goal.items.map(function (it) { return it.text; }).join("\n") : "";
    var err = el("p", "field__err gl-form__err"); err.setAttribute("role", "alert");

    var fType = field("Goal type", type, uid + "-type");
    var fTitle = field("Title", title, uid + "-title");
    var fPl = field("Playlist", playlist, uid + "-pl");
    var fTarget = field("Target", target, uid + "-target");
    var fPeriod = field("Period", period, uid + "-period");
    var fDeadline = field("Deadline (optional)", deadline, uid + "-deadline");
    var fItems = field("Items", items, uid + "-items");
    [fType, fTitle, fPl, fTarget, fPeriod, fDeadline, fItems, err].forEach(function (n) { form.appendChild(n); });

    function sync() {
      var t = type.value;
      fPl.hidden = t !== "playlist";
      fTarget.hidden = t === "playlist" || t === "checklist";
      fPeriod.hidden = t !== "minutes";
      fItems.hidden = t !== "checklist";
      fDeadline.hidden = t === "minutes" || t === "notes";
      fTarget.firstChild.textContent = t === "notes" ? "Notes per week" : "Minutes";
      target.placeholder = t === "notes" ? "e.g. 3" : "e.g. 30";
    }
    type.addEventListener("change", sync); sync();
    playlist.addEventListener("change", function () {
      var p = AQ.store.get(playlist.value);
      if (p && !title.value.trim()) title.value = "Finish " + p.name;
    });

    var row = el("div", "modal__row");
    var cancel = AQ.util.button("Cancel", { cls: "btn btn--ghost btn--sm" });
    var ok = AQ.util.button(goal ? "Save" : "Add goal", { cls: "btn btn--white btn--sm", type: "submit" });
    cancel.addEventListener("click", function () { onCancel(); });
    row.appendChild(cancel); row.appendChild(ok); form.appendChild(row);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var t = type.value, data = { type: t, title: title.value.trim(), deadline: deadline.value || undefined };
      err.textContent = "";
      if (!data.title) { err.textContent = "Give the goal a title."; title.focus(); return; }
      if (t === "playlist") { data.playlistId = playlist.value; if (!data.playlistId) { err.textContent = "Choose a playlist."; playlist.focus(); return; } }
      if (t === "minutes" || t === "notes") {
        data.target = Math.floor(+target.value);
        if (!(data.target >= 1)) { err.textContent = "Enter a target of at least 1."; target.focus(); return; }
        data.period = t === "minutes" ? period.value : "week";
        data.deadline = undefined;
      }
      if (t === "checklist") {
        var old = goal && goal.items ? goal.items : [];
        data.items = items.value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean).map(function (text) {
          var prev = old.filter(function (it) { return it.text === text; })[0];     // keep ticks of unchanged items
          return { text: text, done: !!(prev && prev.done) };
        });
        if (!data.items.length) { err.textContent = "Add at least one item."; items.focus(); return; }
      }
      if (data.deadline && daysUntil(data.deadline) < 0) { err.textContent = "The deadline is in the past."; deadline.focus(); return; }
      onSave(data);
    });
    form.focusFirst = function () { (goal ? title : type).focus(); };
    return form;
  }

  // ===== 8. the card =====
  function mount(container) {
    var root = el("section", "gl");
    root.setAttribute("aria-label", "Goals");
    container.appendChild(root);
    var lastPct = {};                       // goal id -> last drawn percent (rings animate from there)
    var lastStatus = {};                    // goal id -> last status (confetti on the change into "done")
    var firstRender = true;
    var panel = null;                       // the inline form panel when AQ.dialog is absent
    var pendingBurst = null;                // goal id to celebrate after the next render

    function openForm(goal, opener) {
      function done() { if (AQ.dialog && AQ.dialog.isOpen()) AQ.dialog.close(); else closePanel(); }
      function onSave(data) {
        if (goal) AQ.goals.update(goal.id, data); else AQ.goals.add(data);
        done();
      }
      var form = buildForm(goal, onSave, done);
      if (AQ.dialog && typeof AQ.dialog.open === "function") {
        var d = AQ.dialog.open({ kind: "Goal", title: goal ? "Edit goal" : "Add a goal", opener: opener,
          restore: function () { return root.querySelector(".gl-add"); } });
        d.body.appendChild(form);
        form.focusFirst();
      } else {
        closePanel();
        panel = el("div", "gl-panel");
        panel.appendChild(el("h3", "gl-panel__title", goal ? "Edit goal" : "Add a goal"));
        panel.appendChild(form);
        root.appendChild(panel);
        form.focusFirst();
      }
    }
    function closePanel() { if (panel) { panel.remove(); panel = null; var b = root.querySelector(".gl-add"); if (b) b.focus(); } }

    function askDelete(goal, opener) {
      function doIt() { AQ.goals.remove(goal.id); }
      if (AQ.dialog && typeof AQ.dialog.confirm === "function") {
        AQ.dialog.confirm({ title: "Delete this goal?", message: "“" + goal.title + "” will be removed. This cannot be undone.",
          confirmLabel: "Delete", danger: true, opener: opener, restore: function () { return root.querySelector(".gl-add"); } }, doIt);
      } else doIt();
    }

    function buildItem(g) {
      var pr = AQ.goals.progress(g);
      var li = el("li", "gl-item " + statusClass(pr.status));
      li.dataset.id = g.id;
      li.appendChild(ring(pr.percent, firstRender ? 0 : lastPct[g.id]));
      lastPct[g.id] = pr.percent;

      var main = el("div", "gl-main");
      var top = el("div", "gl-row");
      top.appendChild(el("h3", "gl-item__title", g.title));
      var chip = el("span", "gl-chip " + statusClass(pr.status), STATUS_LABEL[pr.status]);
      top.appendChild(chip);
      main.appendChild(top);
      main.appendChild(el("p", "gl-pace", pr.pace));
      var meta = TYPE_LABEL[g.type] + (pr.detail ? " · " + pr.detail : "") + (g.deadline ? " · due " + shortDate(g.deadline) : "");
      main.appendChild(el("p", "gl-meta", meta));
      if (g.type === "checklist") {
        var ul = el("ul", "gl-check");
        g.items.forEach(function (it, i) {
          var row = el("li"); var lab = el("label", "gl-check__row" + (it.done ? " is-done" : ""));
          var cb = el("input"); cb.type = "checkbox"; cb.checked = it.done; cb.dataset.focus = g.id + ":" + i;
          cb.addEventListener("change", function () { AQ.goals.toggleItem(g.id, i, cb.checked); });
          lab.appendChild(cb); lab.appendChild(el("span", null, it.text)); row.appendChild(lab); ul.appendChild(row);
        });
        main.appendChild(ul);
      }
      li.appendChild(main);

      var actions = el("div", "gl-actions");
      if (g.type === "playlist" || g.type === "checklist") {
        var doneBtn = el("button", "iconbtn gl-donebtn"); doneBtn.type = "button";
        doneBtn.appendChild(checkIcon());
        doneBtn.setAttribute("aria-label", g.done ? "Mark as not done" : "Mark as done"); doneBtn.title = doneBtn.getAttribute("aria-label");
        doneBtn.dataset.focus = g.id + ":done";
        doneBtn.setAttribute("aria-pressed", String(!!g.done));
        doneBtn.addEventListener("click", function () { AQ.goals.setDone(g.id, !g.done); });
        actions.appendChild(doneBtn);
      }
      var edit = iconBtn("pencil", "Edit " + g.title); edit.dataset.focus = g.id + ":edit";
      edit.addEventListener("click", function () { openForm(g, edit); });
      var del = iconBtn("trash", "Delete " + g.title, "iconbtn--danger"); del.dataset.focus = g.id + ":del";
      del.addEventListener("click", function () { askDelete(g, del); });
      actions.appendChild(edit); actions.appendChild(del);
      li.appendChild(actions);

      if (!firstRender && lastStatus[g.id] && lastStatus[g.id] !== "done" && pr.status === "done") pendingBurst = g.id;
      lastStatus[g.id] = pr.status;
      return li;
    }

    function render() {
      var focusKey = root.contains(document.activeElement) && document.activeElement.dataset.focus;
      var all = AQ.goals.list();
      var keep = panel;                                 // the inline form survives a re-render
      root.textContent = "";

      var head = el("header", "gl-head");
      var hl = el("div", "gl-head__text");
      hl.appendChild(el("p", "gl-tag", "Goals"));
      var onTrack = 0, open = 0;
      all.forEach(function (g) { var s = AQ.goals.progress(g).status; if (s !== "done") { open++; if (s !== "behind") onTrack++; } });
      hl.appendChild(el("h2", "gl-title", !all.length ? "Set a target" : !open ? "Everything done" : onTrack + " of " + open + " on track"));
      head.appendChild(hl);
      var addBtn = AQ.util.button("Add goal", { cls: "btn btn--ghost btn--sm gl-add", icon: "plus" });
      addBtn.dataset.focus = "add";
      addBtn.addEventListener("click", function () { openForm(null, addBtn); });
      head.appendChild(addBtn);
      root.appendChild(head);

      if (!all.length) {
        var empty = el("div", "gl-empty");
        empty.appendChild(el("p", "gl-empty__t", "No goals yet."));
        empty.appendChild(el("p", "gl-empty__s", "Finish a playlist by a date, study 30 min a day, or tick off a checklist."));
        root.appendChild(empty);
      } else {
        var ul = el("ul", "gl-list");
        all.forEach(function (g) { ul.appendChild(buildItem(g)); });
        root.appendChild(ul);
      }
      if (keep) { root.appendChild(keep); }
      if (!AQ.goals.storageOk()) root.appendChild(el("p", "gl-warn", "Storage is blocked: goals live in memory for this tab only."));

      if (focusKey) { var f = root.querySelector('[data-focus="' + focusKey + '"]'); if (f) f.focus(); }
      if (pendingBurst) {
        var host = root.querySelector('.gl-item[data-id="' + pendingBurst + '"] .gl-ring');
        if (host) confetti(host);
        pendingBurst = null;
      }
      firstRender = false;
    }

    render();
    var offs = [];
    offs.push(AQ.goals.subscribe(render));
    if (AQ.activity && AQ.activity.subscribe) offs.push(AQ.activity.subscribe(function () { if (root.isConnected) render(); }));
    if (AQ.store && AQ.store.subscribe) AQ.store.subscribe(function () { if (root.isConnected) render(); });   // store has no unsubscribe
    var dayTimer = setInterval(function () { if (root.dataset.day !== dayKey(today())) { root.dataset.day = dayKey(today()); render(); } }, 60000);
    root.dataset.day = dayKey(today());

    return { destroy: function () { offs.forEach(function (off) { off(); }); clearInterval(dayTimer); root.remove(); } };
  }

  AQ.goalsView = { mount: mount };
})(window.AQ);

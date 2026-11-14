/* =====================================================================================================
   What this file does:
     The Sticky board: small coloured notes the learner pins on the dashboard ("revise chapter 3",
     "ask about backprop"...). Two parts in one file:
       - data:  AQ.sticky        -> list / add / update / remove / subscribe, saved in localStorage
       - views: AQ.stickyBoard   -> compact(container, opts) for the dashboard card,
                                    full(container, opts) for the expanded board with the note editor

   How it fits:
     dashboard.js builds the "board" card and calls compact() inside it and full() inside the expanded
     panel (expand.js). No other file depends on this one. Styles: css/sticky-board.css.

   Start reading at:
     section 4 (`full`), the board + the editor overlay; sections 1-2 are the plain data layer.
   ===================================================================================================== */
window.AQ = window.AQ || {};
(function (AQ) {
  "use strict";

  // ===== 1. constants + storage =====
  var KEY = "aq.sticky.v1";
  var MAX_NOTES = 200, MAX_TITLE = 80, MAX_TEXT = 2000;

  // paper colours the user picks from when creating a note (id -> label shown in the picker)
  var COLORS = [
    { id: "yellow", label: "Yellow" },
    { id: "pink", label: "Pink" },
    { id: "mint", label: "Mint" },
    { id: "sky", label: "Sky" },
    { id: "lavender", label: "Lavender" },
    { id: "peach", label: "Peach" }
  ];
  function isColor(c) { return COLORS.some(function (x) { return x.id === c; }); }

  var memory = null;                       // in-memory copy, also the fallback when storage is blocked
  var listeners = [];

  function load() {
    if (memory) return memory;
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { raw = []; }
    memory = (Array.isArray(raw) ? raw : []).map(clean).filter(Boolean);
    return memory;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch (e) { /* private mode: keep it in memory */ }
    listeners.slice().forEach(function (fn) { try { fn(); } catch (e) { /* one bad listener must not stop the rest */ } });
  }
  /* trims and validates one stored note; returns null for junk */
  function clean(n) {
    if (!n || typeof n !== "object") return null;
    var title = String(n.title || "").slice(0, MAX_TITLE).trim();
    var text = String(n.text || "").slice(0, MAX_TEXT);
    if (!title && !text.trim()) return null;
    return {
      id: String(n.id || newId()),
      title: title,
      text: text,
      color: isColor(n.color) ? n.color : "yellow",
      pinned: !!n.pinned,
      created: n.created || new Date().toISOString(),
      updated: n.updated || n.created || new Date().toISOString()
    };
  }
  function newId() { return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ===== 2. data API =====
  /* newest first; pinned notes always stay on top */
  function list() {
    return load().slice().sort(function (a, b) {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0;
    });
  }
  function get(id) { return load().filter(function (n) { return n.id === id; })[0] || null; }
  function add(data) {
    load();
    if (memory.length >= MAX_NOTES) return null;
    var now = new Date().toISOString();
    var n = clean({ id: newId(), title: data.title, text: data.text, color: data.color, pinned: data.pinned, created: now, updated: now });
    if (!n) return null;
    memory.push(n); save();
    return n;
  }
  function update(id, patch) {
    var n = get(id); if (!n) return null;
    var next = clean({ id: n.id, created: n.created, updated: new Date().toISOString(),
      title: "title" in patch ? patch.title : n.title, text: "text" in patch ? patch.text : n.text,
      color: patch.color || n.color, pinned: "pinned" in patch ? patch.pinned : n.pinned });
    if (!next) return null;                // emptied note: the caller should remove() instead
    memory[memory.indexOf(n)] = next; save();
    return next;
  }
  function remove(id) {
    load();
    var before = memory.length;
    memory = memory.filter(function (n) { return n.id !== id; });
    if (memory.length !== before) save();
  }
  function subscribe(fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }
  // another tab changed the notes: drop the cache and tell the views
  window.addEventListener("storage", function (e) {
    if (e.key !== KEY) return;
    memory = null; load();
    listeners.slice().forEach(function (fn) { try { fn(); } catch (err) { /* ignore */ } });
  });

  AQ.sticky = { KEY: KEY, COLORS: COLORS, MAX_NOTES: MAX_NOTES, list: list, get: get, add: add, update: update, remove: remove, subscribe: subscribe };

  // ===== 3. small DOM helpers =====
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function reducedMotion() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  }
  function ago(iso) {
    var ms = Date.now() - new Date(iso).getTime();
    if (!(ms >= 0)) return "";
    var min = Math.round(ms / 60000);
    if (min < 1) return "just now";
    if (min < 60) return min + " min ago";
    var h = Math.round(min / 60); if (h < 24) return h + " h ago";
    var d = Math.round(h / 24); if (d < 7) return d + (d === 1 ? " day ago" : " days ago");
    try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch (e) { return ""; }
  }
  /* small, stable tilt per note (-2.5..2.5deg) so the board looks hand-pinned but never jumps around */
  function tiltOf(id) {
    var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return ((Math.abs(h) % 50) / 10 - 2.5).toFixed(1) + "deg";
  }
  /* one paper note (used by both views); `onOpen(note)` runs when it is clicked */
  function noteTile(n, onOpen, small) {
    var b = el("button", "sticky sticky--" + n.color + (small ? " sticky--small" : "") + (n.pinned ? " is-pinned" : ""));
    b.type = "button";
    b.setAttribute("data-no-expand", "");                  // expand.js: a click here never opens the card itself
    b.style.setProperty("--tilt", tiltOf(n.id));
    b.setAttribute("aria-label", "Open note: " + (n.title || n.text.slice(0, 40)));
    b.appendChild(el("span", "sticky__pin"));
    if (n.title) b.appendChild(el("span", "sticky__title", n.title));
    if (n.text) b.appendChild(el("span", "sticky__text", n.text));
    b.appendChild(el("span", "sticky__when", (n.pinned ? "Pinned · " : "") + ago(n.updated)));
    b.addEventListener("click", function (e) { e.stopPropagation(); onOpen(n); });
    return b;
  }

  // ===== 4. views =====
  // --- 4a. compact: the most recent notes, newest on top, plus a "New note" button ---------------------
  // opts.onOpenNote(id) / opts.onNew() are given by dashboard.js (they open the expanded board).
  function compact(container, opts) {
    opts = opts || {};
    var box = el("div", "sboard sboard--compact");
    container.appendChild(box);
    function draw() {
      box.textContent = "";
      var notes = list();
      var stack = el("div", "sboard__stack");
      if (!notes.length) {
        stack.appendChild(el("p", "sboard__empty", "No notes yet. Pin your first reminder, question or idea here."));
      } else {
        notes.slice(0, 4).forEach(function (n) { stack.appendChild(noteTile(n, function () { if (opts.onOpenNote) opts.onOpenNote(n.id); }, true)); });
      }
      box.appendChild(stack);
      var foot = el("div", "sboard__foot");
      var newBtn = el("button", "sboard__new", "+ New note"); newBtn.type = "button"; newBtn.setAttribute("data-no-expand", "");
      newBtn.addEventListener("click", function (e) { e.stopPropagation(); if (opts.onNew) opts.onNew(); });
      foot.appendChild(newBtn);
      foot.appendChild(el("span", "sboard__count", notes.length ? notes.length + (notes.length === 1 ? " note" : " notes") + (notes.length > 4 ? " · +" + (notes.length - 4) + " on the board" : "") : ""));
      box.appendChild(foot);
    }
    draw();
    var unsub = subscribe(draw);
    return { refresh: draw, destroy: function () { unsub(); box.remove(); } };
  }

  // --- 4b. full: the whole board + an editor that zooms open over it ----------------------------------
  // opts.openId: open that note right away; opts.startNew: open an empty editor right away.
  function full(container, opts) {
    opts = opts || {};
    var box = el("div", "sboard sboard--full");
    var bar = el("div", "sboard__bar");
    var heading = el("h3", "sboard__h"); bar.appendChild(heading);   // "4 notes · newest first" (the panel already says "Sticky board")
    // (named newBtn, not `add`: that name is the data function add() that the editor's Save calls)
    var newBtn = el("button", "sboard__new sboard__new--primary", "+ New note"); newBtn.type = "button";
    newBtn.addEventListener("click", function () { openEditor(null); });
    bar.appendChild(newBtn);
    box.appendChild(bar);
    var grid = el("div", "sboard__grid"); box.appendChild(grid);
    container.appendChild(box);

    function draw() {
      grid.textContent = "";
      var notes = list();
      heading.textContent = notes.length ? notes.length + (notes.length === 1 ? " note" : " notes") + " · pinned first, then newest" : "No notes yet";
      if (!notes.length) { grid.appendChild(el("p", "sboard__empty", "Your board is empty. Click “+ New note” to pin something.")); return; }
      notes.forEach(function (n) { grid.appendChild(noteTile(n, function () { openEditor(n.id); }, false)); });
    }

    // ----- the editor: one overlay inside the panel, used for reading, editing and creating -----
    var editor = null;
    function closeEditor() {
      if (!editor) return;
      var ed = editor; editor = null;
      if (reducedMotion()) { ed.remove(); return; }
      ed.classList.add("is-closing");
      setTimeout(function () { ed.remove(); }, 220);
    }
    function openEditor(id) {
      closeEditor();
      var note = id ? get(id) : null;
      var color = note ? note.color : "yellow";
      var ed = el("div", "snote-ed");
      ed.setAttribute("role", "dialog"); ed.setAttribute("aria-label", note ? "Edit note" : "New note");
      var paper = el("form", "snote sticky--" + color);
      paper.noValidate = true;

      var top = el("div", "snote__top");
      var title = el("input", "snote__title"); title.type = "text"; title.maxLength = MAX_TITLE; title.placeholder = "Title";
      title.value = note ? note.title : "";
      top.appendChild(title);
      var pin = el("button", "snote__pin" + (note && note.pinned ? " is-on" : ""), note && note.pinned ? "Pinned" : "Pin"); pin.type = "button";
      pin.setAttribute("aria-pressed", String(!!(note && note.pinned)));
      pin.addEventListener("click", function () {
        var on = pin.getAttribute("aria-pressed") !== "true";
        pin.setAttribute("aria-pressed", String(on)); pin.classList.toggle("is-on", on); pin.textContent = on ? "Pinned" : "Pin";
      });
      top.appendChild(pin);
      paper.appendChild(top);

      var text = el("textarea", "snote__text"); text.maxLength = MAX_TEXT; text.placeholder = "Write your note…";
      text.value = note ? note.text : "";
      paper.appendChild(text);

      // colour preference: one swatch per paper colour
      var picker = el("div", "snote__colors"); picker.setAttribute("role", "radiogroup"); picker.setAttribute("aria-label", "Note colour");
      COLORS.forEach(function (c) {
        var sw = el("button", "snote__swatch sticky--" + c.id); sw.type = "button";
        sw.setAttribute("role", "radio"); sw.setAttribute("aria-label", c.label);
        sw.setAttribute("aria-checked", String(c.id === color));
        sw.addEventListener("click", function () {
          paper.classList.remove("sticky--" + color); color = c.id; paper.classList.add("sticky--" + color);
          Array.prototype.forEach.call(picker.children, function (x) { x.setAttribute("aria-checked", String(x === sw)); });
        });
        picker.appendChild(sw);
      });
      paper.appendChild(picker);

      var foot = el("div", "snote__foot");
      foot.appendChild(el("span", "snote__meta", note ? "Created " + ago(note.created) + (note.updated !== note.created ? " · edited " + ago(note.updated) : "") : "New note"));
      var actions = el("div", "snote__actions");
      if (note) {
        var del = el("button", "snote__btn snote__btn--danger", "Delete"); del.type = "button";
        del.addEventListener("click", function () { remove(note.id); closeEditor(); });
        actions.appendChild(del);
      }
      var cancel = el("button", "snote__btn", "Cancel"); cancel.type = "button";
      cancel.addEventListener("click", closeEditor);
      actions.appendChild(cancel);
      var ok = el("button", "snote__btn snote__btn--primary", note ? "Save" : "Pin to board"); ok.type = "submit";
      actions.appendChild(ok);
      foot.appendChild(actions);
      paper.appendChild(foot);
      var warn = el("p", "snote__warn"); warn.hidden = true; paper.appendChild(warn);

      paper.addEventListener("submit", function (e) {
        e.preventDefault();
        var data = { title: title.value, text: text.value, color: color, pinned: pin.getAttribute("aria-pressed") === "true" };
        if (!data.title.trim() && !data.text.trim()) { warn.hidden = false; warn.textContent = "Write a title or some text first."; title.focus(); return; }
        var saved = note ? update(note.id, data) : add(data);
        if (!saved) { warn.hidden = false; warn.textContent = "The board is full (" + MAX_NOTES + " notes). Delete an old note first."; return; }
        closeEditor();
      });
      // Esc closes the editor only (stopPropagation keeps expand.js from closing the whole panel)
      ed.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); closeEditor(); } });
      ed.addEventListener("click", function (e) { if (e.target === ed) closeEditor(); });

      ed.appendChild(paper);
      box.appendChild(ed);
      editor = ed;
      (note ? text : title).focus();
    }

    draw();
    var unsub = subscribe(draw);
    if (opts.openId && get(opts.openId)) openEditor(opts.openId);
    else if (opts.startNew) openEditor(null);
    return { destroy: function () { unsub(); closeEditor(); box.remove(); } };
  }

  AQ.stickyBoard = { compact: compact, full: full };
})(window.AQ);

/* =====================================================================================================
   What this file does:
     "Compact card <-> full-size view": click a dashboard card and it visibly grows into a large
     dialog panel (a morph), Esc / backdrop / close button shrink it back. One panel open at a time.

   How it fits:
     Any card calls `AQ.expand.attach(cardEl, { title, renderFull(container) })`. streak.js uses it so
     the compact streak card opens the full streak view; dashboard.js can use it for every other card.
     Styles: css/expand.css. Needs only AQ.util (optional) - load it before the cards that use it.

   Start reading at:
     `attach()` (section 6), then `open()` (section 4) and the two animation strategies (section 3).
   ===================================================================================================== */

/* AQspace - expanding cards.
   AQ.expand.attach(card, opts) -> { open(), close(), destroy() }
     opts.title        heading of the full panel (string)
     opts.renderFull   function (container) -> { destroy() } | undefined; fills the panel body
     opts.onOpen       optional callback after the panel is open
     opts.onClose      optional callback after the panel is closed
   AQ.expand.closeAll(), AQ.expand.isOpen()
   The card may set a CSS variable `--card-accent` (any colour); the panel's glow uses it. */
window.AQ = window.AQ || {};
(function (AQ) {
  "use strict";

  // ===== 1. Settings and state =====
  var DURATION = 420;                              // ms, the morph length
  var EASE = "cubic-bezier(.2,.8,.2,1)";
  var MORPH_NAME = "xp-morph";                     // the shared view-transition-name, set only while morphing
  var current = null;                              // the one open panel: { card, overlay, panel, opts, full, opener, closing }
  var animating = false;                           // true while an open/close animation runs (ignore clicks meanwhile)

  function el(tag, cls, text) {
    if (AQ.util && AQ.util.el) return AQ.util.el(tag, cls, text);
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function reducedMotion() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  }
  function supportsViewTransitions() {
    return typeof document.startViewTransition === "function";
  }

  // ===== 2. Building the overlay (backdrop + dialog panel) =====
  function buildOverlay(card, opts) {
    var overlay = el("div", "xp");
    var backdrop = el("div", "xp__backdrop");
    backdrop.setAttribute("data-xp-close", "");
    var panel = el("div", "xp__panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", opts.title || "Details");
    panel.tabIndex = -1;

    // the accent colour comes from the card (CSS variable --card-accent), the panel glow uses it
    var accent = "";
    try { accent = getComputedStyle(card).getPropertyValue("--card-accent").trim(); } catch (e) { /* ignore */ }
    if (accent) panel.style.setProperty("--xp-accent", accent);

    panel.appendChild(el("div", "xp__glow"));
    var head = el("header", "xp__head");
    head.appendChild(el("h2", "xp__title", opts.title || ""));
    var close = el("button", "xp__close");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.setAttribute("data-xp-close", "");
    close.appendChild(el("span", null, "×"));
    head.appendChild(close);
    panel.appendChild(head);
    panel.appendChild(el("div", "xp__body"));

    overlay.appendChild(backdrop);
    overlay.appendChild(panel);
    return { overlay: overlay, panel: panel, body: panel.lastChild };
  }

  // Lock the page scroll without the layout jump of a disappearing scrollbar.
  function lockScroll() {
    var sbw = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.setProperty("--xp-sbw", Math.max(0, sbw) + "px");
    document.body.classList.add("xp-open");
  }
  function unlockScroll() {
    document.body.classList.remove("xp-open");
    document.body.style.removeProperty("--xp-sbw");
  }

  // ===== 3. The two morph strategies =====
  // 3a. View Transitions API: the browser snapshots the card (old) and the panel (new) under the same
  //     view-transition-name and tweens one into the other. The name is set only during the transition.
  function morphWithViewTransition(fromEl, toEl, domUpdate) {
    fromEl.style.viewTransitionName = MORPH_NAME;
    var vt = document.startViewTransition(function () {
      fromEl.style.viewTransitionName = "";
      domUpdate();
      toEl.style.viewTransitionName = MORPH_NAME;
    });
    return vt.finished.catch(function () { /* skipped transitions reject; that is fine */ }).then(function () {
      toEl.style.viewTransitionName = "";
      fromEl.style.viewTransitionName = "";
    });
  }

  // 3b. FLIP fallback: measure First (card) and Last (panel) rects, then animate the panel from the
  //     card's box while a ghost clone of the card scales up and fades out.
  function flipTransform(from, to) {
    return "translate(" + (from.left - to.left) + "px, " + (from.top - to.top) + "px) " +
      "scale(" + (from.width / to.width) + ", " + (from.height / to.height) + ")";
  }
  function morphWithFlip(cardEl, panelEl, overlayEl, opening) {
    var first = cardEl.getBoundingClientRect();
    var last = panelEl.getBoundingClientRect();
    var backdrop = overlayEl.firstChild;
    var timing = { duration: DURATION, easing: EASE, fill: "both" };
    var anims = [];

    var ghost = cardEl.cloneNode(true);
    ghost.className += " xp-ghost";
    ghost.classList.remove("is-expanded");                 // the source card is hidden while open; its ghost must not be
    ghost.style.visibility = "visible";
    ghost.removeAttribute("id");
    ghost.style.left = first.left + "px"; ghost.style.top = first.top + "px";
    ghost.style.width = first.width + "px"; ghost.style.height = first.height + "px";
    overlayEl.appendChild(ghost);

    if (opening) {
      anims.push(backdrop.animate([{ opacity: 0 }, { opacity: 1 }], timing));
      anims.push(ghost.animate([{ transform: "none", opacity: 1 }, { transform: flipTransform(last, first), opacity: 0 }], timing));
      anims.push(panelEl.animate([{ transform: flipTransform(first, last), opacity: 0 }, { transform: "none", opacity: 1 }], timing));
    } else {
      anims.push(backdrop.animate([{ opacity: 1 }, { opacity: 0 }], timing));
      anims.push(ghost.animate([{ transform: flipTransform(last, first), opacity: 0 }, { transform: "none", opacity: 1 }], timing));
      anims.push(panelEl.animate([{ transform: "none", opacity: 1 }, { transform: flipTransform(first, last), opacity: 0 }], timing));
    }
    return Promise.all(anims.map(function (a) { return a.finished.catch(function () {}); })).then(function () { ghost.remove(); });
  }

  // ===== 4. Open =====
  function open(card, opts) {
    if (animating) return;
    if (current) { if (current.card === card) return; closeNow(); }
    var built = buildOverlay(card, opts);
    var state = { card: card, overlay: built.overlay, panel: built.panel, opts: opts, full: null, opener: document.activeElement };
    current = state;
    animating = true;

    function insert() {
      lockScroll();
      document.body.appendChild(state.overlay);
      card.classList.add("is-expanded");
      card.setAttribute("aria-expanded", "true");
      try { state.full = opts.renderFull ? opts.renderFull(built.body) : null; } catch (e) { state.full = null; }
    }
    function done() {
      animating = false;
      if (current !== state) return;
      state.panel.focus({ preventScroll: true });
      if (opts.onOpen) { try { opts.onOpen(); } catch (e) { /* isolate */ } }
    }

    if (reducedMotion()) { insert(); done(); return; }
    if (supportsViewTransitions()) {
      morphWithViewTransition(card, state.panel, insert).then(done);
    } else {
      insert();
      morphWithFlip(card, state.panel, state.overlay, true).then(done);
    }
  }

  // ===== 5. Close =====
  // Removes the panel without animation (used when another card opens while one is open, or on destroy).
  function closeNow() {
    var s = current; if (!s) return;
    current = null;
    teardown(s);
  }
  function teardown(s) {
    if (s.full && s.full.destroy) { try { s.full.destroy(); } catch (e) { /* ignore */ } }
    s.overlay.remove();
    unlockScroll();
    s.card.classList.remove("is-expanded");
    s.card.setAttribute("aria-expanded", "false");
    if (s.opts.onClose) { try { s.opts.onClose(); } catch (e) { /* isolate */ } }
  }
  function restoreFocus(s) {
    var target = s.card.isConnected ? s.card : (s.opener && s.opener.isConnected ? s.opener : null);
    if (target && target.focus) target.focus({ preventScroll: true });
  }
  function close() {
    var s = current; if (!s || animating) return;
    current = null;
    animating = true;
    function finish() { animating = false; restoreFocus(s); }

    if (reducedMotion() || !s.card.isConnected) { teardown(s); finish(); return; }
    if (supportsViewTransitions()) {
      morphWithViewTransition(s.panel, s.card, function () { teardown(s); }).then(finish);
    } else {
      morphWithFlip(s.card, s.panel, s.overlay, false).then(function () { teardown(s); finish(); });
    }
  }

  // ===== 6. Attaching a card =====
  var INTERACTIVE = "a[href], button, input, select, textarea, [data-no-expand]";

  function attach(card, opts) {
    opts = opts || {};
    card.classList.add("xp-card");
    card.setAttribute("role", "button");
    card.setAttribute("aria-haspopup", "dialog");
    card.setAttribute("aria-expanded", "false");
    if (!card.hasAttribute("tabindex")) card.tabIndex = 0;

    // Click anywhere on the card opens it, except on controls inside the card
    // (links, buttons, inputs) unless that control is marked [data-expand].
    function onClick(e) {
      var trigger = e.target.closest("[data-expand]");
      if (!trigger) {
        var control = e.target.closest(INTERACTIVE);
        if (control && control !== card && card.contains(control)) return;
      }
      e.preventDefault();
      open(card, opts);
    }
    function onKey(e) {
      if (e.target !== card) return;                          // keys on inner controls are theirs
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(card, opts); }
    }
    card.addEventListener("click", onClick);
    card.addEventListener("keydown", onKey);

    return {
      open: function () { open(card, opts); },
      close: function () { if (current && current.card === card) close(); },
      destroy: function () {
        card.removeEventListener("click", onClick);
        card.removeEventListener("keydown", onKey);
        card.classList.remove("xp-card");
        if (current && current.card === card) closeNow();
      }
    };
  }

  // ===== 7. Global keyboard (Esc, focus trap) and backdrop clicks =====
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function focusables(panel) {
    return Array.prototype.filter.call(panel.querySelectorAll(FOCUSABLE), function (n) { return n.offsetParent !== null; });
  }
  document.addEventListener("keydown", function (e) {
    if (!current) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    var panel = current.panel, f = focusables(panel), a = document.activeElement;
    if (!f.length) { e.preventDefault(); panel.focus(); return; }
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (a === first || a === panel)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    else if (!panel.contains(a)) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener("click", function (e) {
    if (!current) return;
    if (e.target.closest("[data-xp-close]") && current.overlay.contains(e.target)) close();
  });

  // ===== 8. Public API =====
  AQ.expand = {
    attach: attach,
    closeAll: function () { if (current) close(); },
    isOpen: function () { return !!current; },
    DURATION: DURATION
  };
})(window.AQ);

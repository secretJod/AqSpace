/* =====================================================================================================
   What this file does:
     The "achievement unlocked" celebration (`AQ.achievements`). When the learner earns a badge, a
     centred modal shows a 3D metal medal that spins in and settles, a shine sweeps across it, a
     shockwave ring and confetti fire on landing, then "Congratulations!", the badge name, its criteria
     and the date fade in. Several unlocks are queued and shown one after another.

   How it fits:
     Depends on AQ.streak (streak.js) for the numbers, and wraps AQ.neural.mount (neural.js) to keep the
     dashboard's neural handle for a pulse, so it loads after both and before dashboard.js. It never
     changes streak.js: it subscribes from the outside. Styles: css/achievements.css.
     Celebrated badge ids are kept in localStorage `aq.achievements.seen.v1` so a badge is shown once
     per browser. On the very first run, badges the user already has are marked as seen silently.
     `?celebrate=<id>` (e.g. ?celebrate=blaze) forces the modal, for testing and demos.

   Start reading at:
     section 4 (evaluate) for "when does it trigger", section 7 (openModal) for the UI,
     section 11 (register / celebrate) to add a new badge.
   ===================================================================================================== */
window.AQ = window.AQ || {};
(function (AQ) {
  "use strict";

  // ===== 1. constants =====
  var SEEN_KEY = "aq.achievements.seen.v1";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var SPIN_MS = 1400; // must match the ach-spin-in duration in achievements.css
  var CONFETTI_COUNT = 120;
  var hasDom = typeof document !== "undefined" && !!document.createElement;

  // Metal colours per tier: light / mid / dark stops for the rim, plus an accent for rays and confetti.
  var TIERS = {
    bronze: {
      stops: ["#ffe1c2", "#d98a4e", "#8a4a1c", "#4a230b"],
      accent: "#ff9a52",
      confetti: ["#ffb27a", "#d98a4e", "#ffe1c2"]
    },
    silver: {
      stops: ["#ffffff", "#c9d3de", "#7d8a99", "#38424e"],
      accent: "#9fdcff",
      confetti: ["#e6edf5", "#9fdcff", "#c9d3de"]
    },
    gold: {
      stops: ["#fff6c9", "#ffcf4a", "#c4840c", "#5e3a02"],
      accent: "#ffb020",
      confetti: ["#ffcf4a", "#ffb020", "#fff6c9"]
    },
    legend: {
      stops: ["#b8f6ff", "#b48cff", "#ff7ad9", "#3a1f6b"],
      accent: "#c58cff",
      confetti: ["#5fd4ff", "#b48cff", "#ff7ad9", "#ffd36e"]
    }
  };

  // Icon paths drawn in a 64 x 80 box (the flame matches the streak card's flame shape).
  var ICONS = {
    flame: "M32 4C36 18 52 26 52 48a20 20 0 01-40 0c0-9 4-15 9-20 0 7 3 11 7 12-3-12 2-26 4-36z",
    star: "M32 6l8 20 22 2-17 14 5 22-18-12-18 12 5-22L2 28l22-2z"
  };

  // ===== 2. state =====
  var defs = []; // registered badge definitions
  var queue = []; // badges waiting to be shown
  var showing = false; // a modal is open right now
  var memorySeen = {}; // fallback when localStorage is unavailable
  var neuralHandle = null; // last AQ.neural.mount() result (see section 9)

  // ===== 3. "seen" storage (try/catch, in-memory fallback) =====
  function readSeen() {
    try {
      var raw = window.localStorage.getItem(SEEN_KEY);
      if (raw == null) return null; // null = first run ever
      var list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch {
      return Object.keys(memorySeen).length ? Object.keys(memorySeen) : null;
    }
  }
  function writeSeen(list) {
    list.forEach(function (id) {
      memorySeen[id] = true;
    });
    try {
      window.localStorage.setItem(SEEN_KEY, JSON.stringify(list));
    } catch {
      /* memory only */
    }
  }

  // ===== 4. evaluate: which registered badges are earned but not yet celebrated =====
  // `silent` = mark as seen without a modal (used on the first run so old badges do not pop up).
  function evaluate(silent) {
    var st = streakStats();
    if (!st) return;
    var seenList = readSeen() || [];
    var changed = false;
    defs.forEach(function (d) {
      if (typeof d.isEarned !== "function" || seenList.indexOf(d.id) >= 0) return;
      var earned;
      try {
        earned = !!d.isEarned(st);
      } catch {
        earned = false;
      }
      if (!earned) return;
      seenList.push(d.id);
      changed = true; // mark first, so a second event cannot queue it twice
      if (!silent) enqueue(withDate(d));
    });
    if (changed || silent) writeSeen(seenList);
  }
  function streakStats() {
    try {
      return AQ.streak && AQ.streak.stats ? AQ.streak.stats() : null;
    } catch {
      return null;
    }
  }
  function withDate(d) {
    var copy = {};
    for (var k in d) copy[k] = d[k];
    if (!copy.earnedAt) copy.earnedAt = new Date().toISOString();
    return copy;
  }

  // ===== 5. queue =====
  function enqueue(badge) {
    if (!badge || !badge.id) return;
    if (
      queue.some(function (b) {
        return b.id === badge.id;
      })
    )
      return;
    queue.push(badge);
    if (!showing && hasDom) setTimeout(showNext, 400); // let the page settle first
  }
  function showNext() {
    if (showing || !queue.length) return;
    showing = true;
    openModal(queue.shift(), function () {
      showing = false;
      if (queue.length) setTimeout(showNext, 500);
    });
  }

  // ===== 6. small helpers =====
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svg(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    for (var a in attrs) n.setAttribute(a, attrs[a]);
    return n;
  }
  // With reduced motion the medal appears without the spin and no confetti is drawn (CSS .is-calm).
  function reducedMotion() {
    try {
      return matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }
  function fmtDate(iso) {
    var d = new Date(iso || Date.now());
    try {
      return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    } catch {
      return d.toDateString();
    }
  }
  function uid() {
    return Math.random().toString(36).slice(2, 8);
  }

  // ===== 7. the modal =====
  function openModal(badge, onDone) {
    var tier = TIERS[badge.tier] ? badge.tier : "bronze";
    var palette = TIERS[tier];
    var calm = reducedMotion();
    var previousFocus = document.activeElement;
    var titleId = "ach-title-" + uid();

    // 7a. structure: overlay > rays + confetti canvas + dialog (medal + text + buttons).
    // A real modal dialog for screen readers (role=dialog, aria-modal, labelled by the title); focus moves
    // in, Tab is trapped and focus returns to where it was on close. Badge text goes in with textContent.
    var overlay = el("div", "ach-overlay ach-tier-" + tier + (calm ? " is-calm" : ""));
    overlay.style.setProperty("--ach-accent", palette.accent);
    var rays = el("div", "ach-rays");
    var dialog = el("div", "ach-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", titleId);
    dialog.tabIndex = -1;

    var stage = el("div", "ach-stage");
    var spin = el("div", "ach-medal"); // entrance spin lives here
    var float = el("div", "ach-medal__float"); // idle float lives here (separate transform)
    float.appendChild(medalSvg(badge, palette));
    spin.appendChild(float);
    var wave = el("div", "ach-wave");
    stage.appendChild(wave);
    stage.appendChild(spin);

    var text = el("div", "ach-text");
    text.appendChild(el("p", "ach-kicker", "Achievement unlocked"));
    var title = el("h2", "ach-title", "Congratulations!");
    title.id = titleId;
    text.appendChild(title);
    text.appendChild(el("p", "ach-name", badge.name));
    text.appendChild(el("p", "ach-criteria", badge.criteria || ""));
    text.appendChild(el("p", "ach-date", "Earned " + fmtDate(badge.earnedAt)));

    var actions = el("div", "ach-actions");
    var okBtn = el("button", "ach-btn ach-btn--primary", "Awesome");
    okBtn.type = "button";
    actions.appendChild(okBtn);
    var viewBtn = null;
    if (badge.icon === "flame" || badge.source === "streak") {
      viewBtn = el("button", "ach-btn", "View streak");
      viewBtn.type = "button";
      actions.appendChild(viewBtn);
    }
    text.appendChild(actions);

    var closeX = el("button", "ach-close", "×");
    closeX.type = "button";
    closeX.setAttribute("aria-label", "Close");

    dialog.appendChild(closeX);
    dialog.appendChild(stage);
    dialog.appendChild(text);
    overlay.appendChild(rays);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // 7b. timeline: open -> (spin) -> landed (wave, confetti, text)
    var timers = [];
    var stopConfetti = function () {};
    requestAnimationFrame(function () {
      overlay.classList.add("is-open");
    });
    timers.push(
      setTimeout(
        function () {
          overlay.classList.add("is-landed");
          if (!calm) stopConfetti = confetti(overlay, palette.confetti);
        },
        calm ? 50 : SPIN_MS
      )
    );
    timers.push(
      setTimeout(
        function () {
          okBtn.focus({ preventScroll: true });
        },
        calm ? 100 : SPIN_MS + 300
      )
    );
    dialog.focus({ preventScroll: true });

    // 7c. closing (Esc, backdrop, buttons)
    var closed = false;
    function close(after) {
      if (closed) return;
      closed = true;
      timers.forEach(clearTimeout);
      stopConfetti();
      document.removeEventListener("keydown", onKey, true);
      overlay.classList.add("is-closing");
      setTimeout(
        function () {
          overlay.remove();
          if (previousFocus && previousFocus.focus && document.contains(previousFocus)) {
            try {
              previousFocus.focus({ preventScroll: true });
            } catch {
              /* ignore */
            }
          }
          afterClose(badge, after);
          onDone();
        },
        calm ? 120 : 260
      );
    }
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === "Tab") trapFocus(e, dialog);
    }
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay || e.target === rays) close();
    });
    okBtn.addEventListener("click", function () {
      close();
    });
    closeX.addEventListener("click", function () {
      close();
    });
    if (viewBtn)
      viewBtn.addEventListener("click", function () {
        close("view-streak");
      });
  }

  // Keep Tab / Shift+Tab inside the dialog (same idea as expand.js section 7).
  function trapFocus(e, dialog) {
    var items = Array.prototype.filter.call(dialog.querySelectorAll("button:not([disabled])"), function (n) {
      return n.offsetParent !== null;
    });
    if (!items.length) {
      e.preventDefault();
      return;
    }
    var first = items[0],
      last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // ===== 8. the medal (layered SVG) =====
  // Layers, back to front: drop shadow, rim (metal gradient), bevel, face, tick ring,
  // icon, number plate, then a clipped shine band that CSS sweeps across every few seconds.
  function hexPoints(cx, cy, r) {
    var pts = [];
    for (var i = 0; i < 6; i++) {
      var a = (Math.PI / 180) * (60 * i - 90); // pointy top
      pts.push((cx + r * Math.cos(a)).toFixed(1) + "," + (cy + r * Math.sin(a)).toFixed(1));
    }
    return pts.join(" ");
  }
  function gradient(tag, id, attrs, stops) {
    var g = svg(tag, attrs);
    g.id = id;
    stops.forEach(function (s) {
      g.appendChild(svg("stop", { offset: s[0], "stop-color": s[1], "stop-opacity": s[2] == null ? 1 : s[2] }));
    });
    return g;
  }
  function medalSvg(badge, palette) {
    var id = "ach-" + uid(),
      c = palette.stops;
    var s = svg("svg", { viewBox: "0 0 240 260", class: "ach-medal__svg", "aria-hidden": "true", focusable: "false" });
    var defsEl = svg("defs", {});
    // rim: diagonal metal with a bright band in the middle (reads as polished)
    defsEl.appendChild(
      gradient("linearGradient", id + "-rim", { x1: "0", y1: "0", x2: "1", y2: "1" }, [
        ["0", c[0]],
        [".28", c[1]],
        [".5", c[3]],
        [".62", c[1]],
        [".8", c[0]],
        ["1", c[2]]
      ])
    );
    // bevel: the reverse direction, so the edge catches light opposite the rim
    defsEl.appendChild(
      gradient("linearGradient", id + "-bevel", { x1: "1", y1: "1", x2: "0", y2: "0" }, [
        ["0", c[0]],
        [".45", c[2]],
        ["1", c[3]]
      ])
    );
    // face: dark gunmetal dish with a tier-coloured glow at the top
    defsEl.appendChild(
      gradient("radialGradient", id + "-face", { cx: ".5", cy: ".3", r: ".75" }, [
        ["0", c[1], 0.55],
        [".55", "#151c26"],
        ["1", "#070a0f"]
      ])
    );
    defsEl.appendChild(
      gradient("linearGradient", id + "-icon", { x1: "0", y1: "1", x2: "0", y2: "0" }, [
        ["0", c[2]],
        [".55", c[1]],
        ["1", c[0]]
      ])
    );
    defsEl.appendChild(
      gradient("linearGradient", id + "-shine", { x1: "0", y1: "0", x2: "1", y2: "0" }, [
        ["0", "#fff", 0],
        [".5", "#fff", 0.75],
        ["1", "#fff", 0]
      ])
    );
    var clip = svg("clipPath", { id: id + "-clip" });
    clip.appendChild(svg("polygon", { points: hexPoints(120, 128, 112) }));
    defsEl.appendChild(clip);
    s.appendChild(defsEl);

    s.appendChild(svg("polygon", { points: hexPoints(120, 136, 112), class: "ach-medal__shadow" }));
    s.appendChild(svg("polygon", { points: hexPoints(120, 128, 112), fill: "url(#" + id + "-rim)" }));
    s.appendChild(svg("polygon", { points: hexPoints(120, 128, 98), fill: "url(#" + id + "-bevel)" }));
    s.appendChild(
      svg("polygon", {
        points: hexPoints(120, 128, 90),
        fill: "url(#" + id + "-face)",
        stroke: c[3],
        "stroke-width": "2"
      })
    );
    // engraved tick ring: 60 short dashes on a circle (dasharray = circumference / 60)
    var circ = 2 * Math.PI * 70;
    s.appendChild(
      svg("circle", {
        cx: "120",
        cy: "128",
        r: "70",
        fill: "none",
        stroke: c[0],
        "stroke-opacity": ".55",
        "stroke-width": "6",
        "stroke-dasharray": "1.4 " + (circ / 60 - 1.4).toFixed(2)
      })
    );
    s.appendChild(
      svg("circle", {
        cx: "120",
        cy: "128",
        r: "62",
        fill: "none",
        stroke: c[1],
        "stroke-opacity": ".35",
        "stroke-width": "1"
      })
    );

    var icon = svg("g", { transform: "translate(92 70) scale(.875)" });
    icon.appendChild(
      svg("path", {
        d: ICONS[badge.icon] || ICONS.star,
        fill: "url(#" + id + "-icon)",
        stroke: c[0],
        "stroke-width": "1.5",
        "stroke-opacity": ".8"
      })
    );
    if (badge.icon === "flame")
      icon.appendChild(
        svg("path", {
          d: "M32 34c3 7 11 10 11 19a11 11 0 01-22 0c0-5 3-8 6-10 0 4 2 6 4 6-1-6 0-11 1-15z",
          fill: "#0b0f15",
          "fill-opacity": ".55"
        })
      );
    s.appendChild(icon);

    if (badge.number != null) {
      s.appendChild(
        svg("rect", {
          x: "78",
          y: "160",
          width: "84",
          height: "30",
          rx: "4",
          fill: "url(#" + id + "-rim)",
          stroke: c[3],
          "stroke-width": "1.5"
        })
      );
      var num = svg("text", { x: "120", y: "182", "text-anchor": "middle", class: "ach-medal__num", fill: "#0b0f15" });
      num.textContent = String(badge.number);
      s.appendChild(num);
    }

    var shineGroup = svg("g", { "clip-path": "url(#" + id + "-clip)" });
    shineGroup.appendChild(
      svg("rect", {
        x: "-80",
        y: "-40",
        width: "70",
        height: "340",
        fill: "url(#" + id + "-shine)",
        class: "ach-medal__shine"
      })
    );
    s.appendChild(shineGroup);
    return s;
  }

  // ===== 9. confetti (own canvas code; returns stop()) =====
  function confetti(host, colours) {
    var canvas = el("canvas", "ach-confetti");
    var ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) return function () {};
    host.appendChild(canvas);
    var w = (canvas.width = window.innerWidth),
      h = (canvas.height = window.innerHeight);
    var palette = colours.concat(["#ffffff"]);
    var originY = h * 0.38;
    var pieces = [];
    for (var i = 0; i < CONFETTI_COUNT; i++) {
      var angle = Math.random() * Math.PI * 2,
        speed = 4 + Math.random() * 9;
      pieces.push({
        x: w / 2,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 5, // biased upwards
        size: 5 + Math.random() * 7,
        rot: Math.random() * 6.28,
        vr: (Math.random() - 0.5) * 0.35,
        drift: Math.random() * 6.28,
        colour: palette[i % palette.length]
      });
    }
    var raf = 0,
      started = performance.now(),
      stopped = false;
    function frame(now) {
      if (stopped) return;
      ctx.clearRect(0, 0, w, h);
      var alive = 0;
      pieces.forEach(function (p) {
        p.vy += 0.22; // gravity
        p.vx *= 0.985;
        p.vy *= 0.985; // air drag
        p.drift += 0.08;
        p.x += p.vx + Math.sin(p.drift) * 0.8; // side-to-side flutter
        p.y += p.vy;
        p.rot += p.vr;
        if (p.y < h + 20) alive++;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(1, Math.abs(Math.cos(p.drift))); // fake 3D flip
        ctx.fillStyle = p.colour;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      });
      if (alive && now - started < 5000) raf = requestAnimationFrame(frame);
      else stop();
    }
    function stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      canvas.remove();
    }
    raf = requestAnimationFrame(frame);
    return stop;
  }

  // ===== 10. after closing: open the streak panel, pulse the neural net, glow the badge =====
  function afterClose(badge, action) {
    if (action === "view-streak") {
      var card =
        document.querySelector(".dash__card--streak .xp-card") || document.querySelector(".dash__card--streak");
      if (card && typeof card.click === "function") card.click();
    }
    try {
      if (neuralHandle && neuralHandle.pulse) neuralHandle.pulse("core", "streak");
    } catch {
      /* optional */
    }
    setTimeout(
      function () {
        glowBadge(badge.name);
      },
      action === "view-streak" ? 700 : 50
    );
  }
  function glowBadge(name) {
    Array.prototype.forEach.call(document.querySelectorAll(".stk-badge"), function (li) {
      var t = li.querySelector(".stk-badge__t");
      if (!t || t.textContent !== name) return;
      li.classList.add("ach-glow");
      setTimeout(function () {
        li.classList.remove("ach-glow");
      }, 2000);
    });
  }

  // Wrap AQ.neural.mount (neural.js loads before us) to keep the dashboard's handle for pulses.
  if (AQ.neural && typeof AQ.neural.mount === "function" && !AQ.neural.mount.__achWrapped) {
    var originalMount = AQ.neural.mount;
    AQ.neural.mount = function () {
      var handle = originalMount.apply(this, arguments);
      neuralHandle = handle;
      return handle;
    };
    AQ.neural.mount.__achWrapped = true;
  }

  // ===== 11. public API =====
  /**
   * Adds badge definitions (a definition with the same id replaces the old one). Each is checked
   * against AQ.streak.stats() after every streak change.
   * @param {Object|Object[]} list { id, name, tier: "bronze"|"silver"|"gold"|"legend", icon: "flame"|"star",
   *   title?, criteria, number?, source?, isEarned?(stats) -> boolean }
   * @returns {void}
   */
  function register(list) {
    (Array.isArray(list) ? list : [list]).forEach(function (d) {
      if (!d || !d.id) return;
      defs = defs.filter(function (x) {
        return x.id !== d.id;
      });
      defs.push(d);
    });
  }
  /**
   * Queues the celebration modal for a badge, whether or not it was registered.
   * @param {Object} badge { id, name, tier, icon, title?, criteria, number?, earnedAt? (ISO, defaults to now) }
   * @returns {void}
   */
  function celebrate(badge) {
    enqueue(withDate(badge || {}));
  }
  function findDef(id) {
    return (
      defs.filter(function (d) {
        return d.id === id;
      })[0] || null
    );
  }

  // Streak milestones (same numbers and names as MILESTONES in streak.js).
  var STREAK_BADGES = [
    { n: 7, id: "spark", name: "Spark", tier: "bronze", criteria: "Kept a 7-day learning streak" },
    { n: 30, id: "blaze", name: "Blaze", tier: "silver", criteria: "Kept a 30-day learning streak" },
    { n: 100, id: "inferno", name: "Inferno", tier: "gold", criteria: "Kept a 100-day learning streak" },
    { n: 365, id: "supernova", name: "Supernova", tier: "legend", criteria: "Kept a 365-day learning streak" }
  ];
  register(
    STREAK_BADGES.map(function (m) {
      return {
        id: m.id,
        name: m.name,
        tier: m.tier,
        icon: "flame",
        source: "streak",
        number: m.n,
        title: m.name + " streak",
        criteria: m.criteria,
        isEarned: function (st) {
          return (st.longest || 0) >= m.n;
        }
      };
    })
  );

  AQ.achievements = {
    register: register,
    celebrate: celebrate
  };

  // ===== 12. start: first-run silence, ?celebrate=<id>, then watch the streak =====
  (function start() {
    var firstRun = readSeen() === null;
    var graceUntil = firstRun ? Date.now() + 3000 : 0; // first run: other scripts may still load/seed data
    evaluate(firstRun); // first run: mark old badges seen, no modal
    if (AQ.streak && typeof AQ.streak.subscribe === "function") {
      AQ.streak.subscribe(function (evt) {
        // Silent for a change synced from another tab (that tab celebrates) and for the first seconds
        // of a first-ever run. Only real activity in this tab shows the modal.
        var type = evt && evt.type;
        evaluate(type === "sync" || Date.now() < graceUntil);
      });
    }
    var forced = null;
    try {
      var m = /[?&]celebrate=([\w-]+)/.exec(location.search);
      forced = m && m[1].toLowerCase();
    } catch {
      /* no location */
    }
    if (forced && findDef(forced)) {
      var d = findDef(forced);
      setTimeout(function () {
        celebrate(d);
      }, 500); // after the dashboard has drawn
    }
  })();
})(window.AQ);

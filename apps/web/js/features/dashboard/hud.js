/*
What: JARVIS-style HUD chrome for the dashboard: an arc-reactor "core" widget, card frames
      (corner brackets + hover scan line + Border Beam), a decode/scramble text effect, a typed
      system-log ticker and a page backdrop (hex grid + retro grid floor + scan sweep).
How it fits: pure decoration on top of dashboard.js. Every function returns a handle with destroy().
      All animation is CSS (css/hud.css) except the scramble + ticker, which use a few timers.
      prefers-reduced-motion: CSS stops the animations, scramble/ticker write the final text at once.
Start reading at: section 6, the public API at the bottom.

AQ.hud.core(container, { label, value, sub }) -> { set(value, sub), destroy() }
AQ.hud.frame(cardEl)                          -> { destroy() }
AQ.hud.scramble(el, text, { duration })      -> { cancel() }
AQ.hud.ticker(container, getLines)            -> { refresh(), destroy() }   getLines() -> ["SYNC ...", ...]
AQ.hud.backdrop(container)                    -> { destroy() }
*/
(function () {
  "use strict";
  var AQ = (window.AQ = window.AQ || {});
  var SVG_NS = "http://www.w3.org/2000/svg";
  var GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&@$<>/\\=+*";

  // ===== 1. Helpers =====
  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  function div(cls) {
    var d = document.createElement("div");
    d.className = cls;
    return d;
  }
  function svg(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    for (var a in attrs) n.setAttribute(a, attrs[a]);
    return n;
  }
  function remove(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  // ===== 2. scramble(): random glyphs settle to the final text, left -> right =====
  function scramble(el, text, opts) {
    text = String(text);
    var duration = (opts && opts.duration) || 700;
    if (el._hudScramble) el._hudScramble.cancel();
    if (reducedMotion()) {
      el.textContent = text;
      return { cancel: function () {} };
    }
    var start = performance.now(),
      timer = 0;
    function tick() {
      var p = Math.min(1, (performance.now() - start) / duration);
      var settled = Math.floor(p * text.length),
        out = "";
      for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i);
        // spaces and already-settled characters stay put; the rest flicker
        out += i < settled || ch === " " ? ch : GLYPHS.charAt((Math.random() * GLYPHS.length) | 0);
      }
      el.textContent = out;
      if (p < 1) timer = setTimeout(tick, 40);
      else el._hudScramble = null;
    }
    var handle = {
      cancel: function () {
        clearTimeout(timer);
        el.textContent = text;
        el._hudScramble = null;
      }
    };
    el._hudScramble = handle;
    tick();
    return handle;
  }

  // ===== 3. core(): the arc-reactor widget =====
  // rings = [radius, tick count, tick length, css modifier]; each ring spins via CSS at its own speed/direction
  // Instrument bezel: a fine 120-tick scale (major every 5th), a sparse 12-index dial that step-rotates
  // like a mechanical counter, and a 60-tick inner scale.
  var RINGS = [
    [94, 120, 3, "a"],
    [80, 12, 6, "b"],
    [68, 60, 2.5, "c"]
  ];
  function tickRing(r, count, len, mod) {
    var g = svg("g", { class: "hud-core__ring hud-core__ring--" + mod });
    for (var i = 0; i < count; i++) {
      var ang = (i / count) * Math.PI * 2,
        major = count <= 12 || i % 5 === 0;
      var r2 = r - (major ? len * 1.8 : len);
      g.appendChild(
        svg("line", {
          x1: (100 + Math.cos(ang) * r).toFixed(2),
          y1: (100 + Math.sin(ang) * r).toFixed(2),
          x2: (100 + Math.cos(ang) * r2).toFixed(2),
          y2: (100 + Math.sin(ang) * r2).toFixed(2),
          class: major ? "is-major" : ""
        })
      );
    }
    return g;
  }
  // segmented arcs: a dashed circle whose dash pattern draws 6 separated segments
  function segmentRing(r, mod) {
    var c = 2 * Math.PI * r,
      seg = c / 6;
    return svg("circle", {
      cx: 100,
      cy: 100,
      r: r,
      class: "hud-core__seg hud-core__seg--" + mod,
      "stroke-dasharray": (seg * 0.7).toFixed(1) + " " + (seg * 0.3).toFixed(1)
    });
  }
  function core(container, opts) {
    opts = opts || {};
    var box = div("hud-core");
    var art = svg("svg", { viewBox: "0 0 200 200", class: "hud-core__svg", "aria-hidden": "true" });
    art.appendChild(svg("circle", { cx: 100, cy: 100, r: 98, class: "hud-core__outline" }));
    RINGS.forEach(function (r) {
      art.appendChild(tickRing(r[0], r[1], r[2], r[3]));
    });
    art.appendChild(svg("circle", { cx: 100, cy: 100, r: 86, class: "hud-core__hair" }));
    art.appendChild(svg("circle", { cx: 100, cy: 100, r: 74, class: "hud-core__hair" }));
    art.appendChild(segmentRing(56, "a"));
    art.appendChild(segmentRing(50, "b"));
    art.appendChild(svg("circle", { cx: 100, cy: 100, r: 44, class: "hud-core__glow" }));
    box.appendChild(art);
    var mid = div("hud-core__mid");
    var label = div("hud-core__label");
    label.textContent = opts.label || "";
    var value = div("hud-core__value");
    var sub = div("hud-core__sub");
    mid.appendChild(label);
    mid.appendChild(value);
    mid.appendChild(sub);
    box.appendChild(mid);
    container.appendChild(box);

    function set(v, s) {
      scramble(value, v == null ? "" : v, { duration: 900 });
      if (s != null) scramble(sub, s, { duration: 700 });
    }
    set(opts.value, opts.sub || "");
    return {
      set: set,
      destroy: function () {
        if (value._hudScramble) value._hudScramble.cancel();
        remove(box);
      }
    };
  }

  // ===== 4. frame(): corner brackets + scan line + Border Beam on a card =====
  function frame(cardEl) {
    var layer = div("hud-frame");
    layer.setAttribute("aria-hidden", "true");
    ["tl", "tr", "bl", "br"].forEach(function (c) {
      layer.appendChild(div("hud-frame__corner hud-frame__corner--" + c));
    });
    layer.appendChild(div("hud-frame__scan"));
    layer.appendChild(div("hud-frame__beam"));
    cardEl.classList.add("hud-framed");
    cardEl.appendChild(layer);
    return {
      destroy: function () {
        cardEl.classList.remove("hud-framed");
        remove(layer);
      }
    };
  }

  // ===== 5. ticker(): a typed, one-line system log =====
  function ticker(container, getLines) {
    var box = div("hud-ticker");
    box.setAttribute("role", "status");
    var prompt = document.createElement("span");
    prompt.className = "hud-ticker__prompt";
    prompt.textContent = "›";
    var text = document.createElement("span");
    text.className = "hud-ticker__text";
    var caret = document.createElement("span");
    caret.className = "hud-ticker__caret";
    caret.setAttribute("aria-hidden", "true");
    box.appendChild(prompt);
    box.appendChild(text);
    box.appendChild(caret);
    container.appendChild(box);

    var lines = [],
      index = 0,
      timer = 0,
      still = reducedMotion();
    function load() {
      try {
        lines = (getLines && getLines()) || [];
      } catch {
        lines = [];
      }
    }
    function typeLine(line, pos) {
      text.textContent = line.slice(0, pos);
      if (pos < line.length) {
        timer = setTimeout(
          function () {
            typeLine(line, pos + 1);
          },
          24 + Math.random() * 30
        );
        return;
      }
      timer = setTimeout(nextLine, 2600); // hold the finished line, then the next one
    }
    function nextLine() {
      if (!lines.length) load();
      if (!lines.length) return;
      var line = String(lines[index % lines.length]);
      index++;
      if (index % lines.length === 0) load(); // re-read real data once per cycle
      if (still) {
        text.textContent = line;
        timer = setTimeout(nextLine, 5000);
        return;
      }
      typeLine(line, 0);
    }
    load();
    nextLine();
    return {
      refresh: function () {
        load();
      },
      destroy: function () {
        clearTimeout(timer);
        remove(box);
      }
    };
  }

  // ===== 6. backdrop(): hex grid + perspective floor + scan sweep (all CSS) =====
  function backdrop(container) {
    var layer = div("hud-backdrop");
    layer.setAttribute("aria-hidden", "true");
    layer.appendChild(div("hud-backdrop__hex"));
    var floor = div("hud-backdrop__floor");
    floor.appendChild(div("hud-backdrop__floor-grid"));
    layer.appendChild(floor);
    layer.appendChild(div("hud-backdrop__sweep"));
    container.classList.add("hud-host");
    container.insertBefore(layer, container.firstChild);
    return {
      destroy: function () {
        container.classList.remove("hud-host");
        remove(layer);
      }
    };
  }

  AQ.hud = { core: core, frame: frame, scramble: scramble, ticker: ticker, backdrop: backdrop };
})();

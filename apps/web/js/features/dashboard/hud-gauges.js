/* =====================================================================================================
   What this file does:
     The small HUD read-out widgets of the dashboard, drawn as SVG / plain DOM (no canvas, no innerHTML):
       segArc      a segmented 270-degree arc gauge with tick marks (focus score, consistency ...)
       tickBar     a row of tick marks, the first N lit (a "level meter")
       radar       a 5-axis spider chart of habits
       clock24     a 24-hour radial clock: one bar per hour, length = minutes, plus a "now" hand
       ticker      Number Ticker: every digit rolls on its own reel to the new value
       orbit       Orbiting Circles: clickable satellite chips that circle a centre element
       reactor     a fallback arc-reactor core, used only while Dev A's AQ.hud.core is not there

   How it fits:
     Loaded before dashboard.js, which is the only caller (`AQ.hudGauges.*`). Styles: css/dashboard.css
     (section "HUD widgets"). Animations are CSS transitions; with reduced motion they are switched off
     in the CSS, so this file never has to check.

   Start reading at:
     `segArc()` in section 2 (the pattern every widget follows: build SVG, return {node, set()}).
   ===================================================================================================== */
(function () {
  "use strict";
  var el = AQ.util.el;
  var SVG_NS = "http://www.w3.org/2000/svg";

  // ===== 1. Helpers =====
  function svg(tag, attrs) { var n = document.createElementNS(SVG_NS, tag); for (var a in attrs) n.setAttribute(a, attrs[a]); return n; }
  function clamp01(x) { return Math.max(0, Math.min(1, +x || 0)); }
  // Point on a circle; angle in degrees, 0 = top, clockwise.
  function polar(cx, cy, r, deg) { var rad = (deg - 90) * Math.PI / 180; return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]; }
  function arcD(cx, cy, r, a0, a1) {
    var p0 = polar(cx, cy, r, a0), p1 = polar(cx, cy, r, a1);
    return "M" + p0[0].toFixed(2) + " " + p0[1].toFixed(2) + " A" + r + " " + r + " 0 " + (a1 - a0 > 180 ? 1 : 0) + " 1 " + p1[0].toFixed(2) + " " + p1[1].toFixed(2);
  }
  function reduced() { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } }

  // ===== 2. Arc instrument gauge =====
  // opts: { size, segments, value (0..1), caption } -> { node, set(value) }
  // A real instrument face: a 270deg hairline scale (-135..+135) with minor/major ticks and numeric
  // labels 0..100, a thin value arc and a needle. `segments` only sets the minor tick density.
  function segArc(opts) {
    opts = opts || {};
    var size = opts.size || 140, c = size / 2, r = size / 2 - 16, n = Math.max(20, opts.segments || 40);
    var s = svg("svg", { viewBox: "0 0 " + size + " " + size, "class": "hg-arc is-inst", "aria-hidden": "true", focusable: "false" });
    s.appendChild(svg("path", { d: arcD(c, c, r, -135, 135), "class": "hg-arc__track" }));
    // scale: minor every 2.5 units, mid every 5, major every 10 (labelled every 20)
    for (var t = 0; t <= 40; t++) {
      var a = -135 + 270 * t / 40, major = t % 4 === 0, mid = t % 2 === 0;
      var p0 = polar(c, c, r + 3, a), p1 = polar(c, c, r + (major ? 10 : mid ? 7 : 5), a);
      s.appendChild(svg("line", { x1: p0[0].toFixed(2), y1: p0[1].toFixed(2), x2: p1[0].toFixed(2), y2: p1[1].toFixed(2), "class": "hg-arc__tick" + (major ? " is-long" : "") }));
      if (t % 8 === 0 && size >= 120) {
        var q = polar(c, c, r - 9, a);
        var lab = svg("text", { x: q[0].toFixed(1), y: (q[1] + 2.5).toFixed(1), "text-anchor": "middle", "class": "hg-arc__num" });
        lab.textContent = String(t * 2.5); s.appendChild(lab);
      }
    }
    var val = svg("path", { "class": "hg-arc__val", d: "" }); s.appendChild(val);
    var needle = svg("g", { "class": "hg-arc__needle" });
    needle.appendChild(svg("line", { x1: c, y1: c - r + 14, x2: c, y2: c - r - 6, "class": "hg-arc__hand" }));
    s.appendChild(needle);
    function set(v) {
      v = clamp01(v);
      var a1 = -135 + 270 * v;
      val.setAttribute("d", v > 0.002 ? arcD(c, c, r, -135, a1) : "");
      needle.style.transform = "rotate(" + a1.toFixed(2) + "deg)";
      needle.style.transformOrigin = c + "px " + c + "px";
    }
    set(opts.value || 0);
    return { node: s, set: set };
  }

  // ===== 3. Linear scale (level meter) =====
  // -> { node, set(value 0..1) }   a hairline track with `count` tick marks, a thin solid fill and a marker.
  function tickBar(count) {
    count = count || 20;
    var row = el("span", "hg-scale"); row.setAttribute("aria-hidden", "true");
    var ticks = el("span", "hg-scale__ticks");
    for (var i = 0; i <= count; i++) { var t = el("i", "hg-scale__t" + (i % 5 === 0 ? " is-major" : "")); t.style.setProperty("--x", (100 * i / count) + "%"); ticks.appendChild(t); }
    var fill = el("span", "hg-scale__fill"), mark = el("span", "hg-scale__mark");
    row.appendChild(ticks); row.appendChild(fill); row.appendChild(mark);
    function set(v) { var p = (100 * clamp01(v)).toFixed(1) + "%"; fill.style.width = p; mark.style.left = p; }
    set(0);
    return { node: row, set: set };
  }

  // ===== 4. Radar / spider chart =====
  // habits: [{label, value 0..1}] (5 expected) -> { node, set(habits) }
  function radar(habits, size) {
    size = size || 200;
    var c = size / 2, r = size / 2 - 30, n = habits.length;
    var s = svg("svg", { viewBox: "0 0 " + size + " " + size, "class": "hg-radar", role: "img" });
    var title = svg("title", {}); s.appendChild(title);
    // rings at 25 / 50 / 75 / 100 %, each with a small scale label on the first spoke
    [0.25, 0.5, 0.75, 1].forEach(function (k) {
      var pts = [];
      for (var i = 0; i < n; i++) pts.push(polar(c, c, r * k, 360 * i / n).map(function (v) { return v.toFixed(1); }).join(","));
      s.appendChild(svg("polygon", { points: pts.join(" "), "class": "hg-radar__ring" + (k === 1 ? " is-outer" : "") }));
      var lp = polar(c, c, r * k, 0);
      var lt = svg("text", { x: (lp[0] + 3).toFixed(1), y: (lp[1] + 7).toFixed(1), "class": "hg-radar__scale" });
      lt.textContent = String(k * 100); s.appendChild(lt);
    });
    var labels = [];
    for (var i = 0; i < n; i++) {
      var p = polar(c, c, r, 360 * i / n), q = polar(c, c, r + 16, 360 * i / n);
      s.appendChild(svg("line", { x1: c, y1: c, x2: p[0].toFixed(1), y2: p[1].toFixed(1), "class": "hg-radar__spoke" }));
      var t = svg("text", { x: q[0].toFixed(1), y: (q[1] + 3).toFixed(1), "text-anchor": "middle", "class": "hg-radar__label" });
      s.appendChild(t); labels.push(t);
    }
    var shape = svg("polygon", { "class": "hg-radar__shape", points: "" });
    s.appendChild(shape);
    var dots = [];
    for (i = 0; i < n; i++) { var d = svg("rect", { width: 3, height: 3, "class": "hg-radar__dot" }); s.appendChild(d); dots.push(d); }
    function set(list) {
      var pts = [];
      list.forEach(function (h, k) {
        var p = polar(c, c, r * Math.max(0.04, clamp01(h.value)), 360 * k / n);
        pts.push(p[0].toFixed(1) + "," + p[1].toFixed(1));
        dots[k].setAttribute("x", (p[0] - 1.5).toFixed(1)); dots[k].setAttribute("y", (p[1] - 1.5).toFixed(1));
        labels[k].textContent = h.label.toUpperCase();
      });
      shape.setAttribute("points", pts.join(" "));
      title.textContent = "Habits: " + list.map(function (h) { return h.label + " " + Math.round(100 * clamp01(h.value)) + "%"; }).join(", ");
    }
    set(habits);
    return { node: s, set: set };
  }

  // ===== 5. 24-hour radial clock =====
  // hours: 24 numbers (minutes) -> { node, set(hours) }. Midnight at the top; bar length = minutes / max.
  function clock24(hours, size) {
    size = size || 170;
    var c = size / 2, inner = size * 0.24, outer = size / 2 - 16;
    var s = svg("svg", { viewBox: "0 0 " + size + " " + size, "class": "hg-clock", "aria-hidden": "true", focusable: "false" });
    s.appendChild(svg("circle", { cx: c, cy: c, r: outer + 6, "class": "hg-clock__rim" }));
    s.appendChild(svg("circle", { cx: c, cy: c, r: inner - 4, "class": "hg-clock__rim is-inner" }));
    // 96 minor ticks (every 15 min) on the rim, the hour ones longer
    for (var t = 0; t < 96; t++) {
      var a = t * 3.75, isHour = t % 4 === 0;
      var p0 = polar(c, c, outer + 6, a), p1 = polar(c, c, outer + (isHour ? 11 : 8), a);
      s.appendChild(svg("line", { x1: p0[0].toFixed(2), y1: p0[1].toFixed(2), x2: p1[0].toFixed(2), y2: p1[1].toFixed(2), "class": "hg-clock__tick" + (isHour ? " is-hour" : "") }));
    }
    var bars = [];
    for (var h = 0; h < 24; h++) {
      var b = svg("path", { "class": "hg-clock__bar" });
      b.style.setProperty("--i", String(h));
      s.appendChild(b); bars.push(b);
    }
    [["00", 0], ["06", 90], ["12", 180], ["18", 270]].forEach(function (m) {
      var p = polar(c, c, inner - 13, m[1]);
      var txt = svg("text", { x: p[0].toFixed(1), y: (p[1] + 3).toFixed(1), "text-anchor": "middle", "class": "hg-clock__mark" });
      txt.textContent = m[0]; s.appendChild(txt);
    });
    // the "now" hand
    var now = new Date(), na = (now.getHours() + now.getMinutes() / 60) * 15;
    var h0 = polar(c, c, inner - 2, na), h1 = polar(c, c, outer + 12, na);
    s.appendChild(svg("line", { x1: h0[0].toFixed(1), y1: h0[1].toFixed(1), x2: h1[0].toFixed(1), y2: h1[1].toFixed(1), "class": "hg-clock__hand" }));
    function set(list) {
      var max = 0; list.forEach(function (v) { if (v > max) max = v; });
      bars.forEach(function (b, k) {
        var lvl = max ? list[k] / max : 0, a0 = k * 15 + 5.5, a1 = (k + 1) * 15 - 5.5;
        var rOut = inner + (outer - inner) * Math.max(0.06, lvl);
        var p0 = polar(c, c, inner, a0), p1 = polar(c, c, rOut, a0), p2 = polar(c, c, rOut, a1), p3 = polar(c, c, inner, a1);
        b.setAttribute("d", "M" + p0.join(" ") + " L" + p1.join(" ") + " A" + rOut + " " + rOut + " 0 0 1 " + p2.join(" ") + " L" + p3.join(" ") + " A" + inner + " " + inner + " 0 0 0 " + p0.join(" ") + "Z");
        b.style.setProperty("--lvl", lvl.toFixed(3));
        b.classList.toggle("is-peak", lvl === 1 && max > 0);
      });
    }
    set(hours);
    return { node: s, set: set };
  }

  // ===== 6. Number Ticker (rolling digit reels) =====
  // ticker(node) -> { set(text) }. Each digit is a reel of 0-9 moved with translateY; other characters
  // (":", " ", "h") are plain spans. Screen readers get the text through aria-label on `node`.
  function ticker(node) {
    node.classList.add("hg-num");
    var current = "";
    function reel() {
      var r = el("span", "hg-num__reel"), strip = el("span", "hg-num__strip");
      for (var d = 0; d <= 9; d++) strip.appendChild(el("span", "hg-num__d", String(d)));
      r.appendChild(strip); r.strip = strip;
      return r;
    }
    function set(text) {
      text = String(text);
      node.setAttribute("aria-label", text);
      if (text === current) return;
      // rebuild only when the shape (digit / non-digit layout) changes; otherwise just roll the reels
      var shape = text.replace(/\d/g, "0"), oldShape = current.replace(/\d/g, "0");
      if (shape !== oldShape) {
        node.textContent = "";
        for (var i = 0; i < text.length; i++) {
          var ch = text.charAt(i);
          var part = /\d/.test(ch) ? reel() : el("span", "hg-num__c", ch);
          part.setAttribute("aria-hidden", "true");
          node.appendChild(part);
        }
      }
      var parts = node.children;
      // roll on the next frame so a fresh reel animates from 0
      function roll() {
        for (var k = 0; k < text.length; k++) {
          var c = text.charAt(k);
          if (/\d/.test(c) && parts[k] && parts[k].strip) parts[k].strip.style.transform = "translateY(" + (-10 * +c) + "%)";
        }
      }
      if (reduced()) roll(); else requestAnimationFrame(function () { requestAnimationFrame(roll); });
      current = text;
    }
    return { set: set };
  }

  // ===== 7. Orbiting satellites =====
  // orbit(centreEl, sats) -> { node, set(sats), destroy() }
  // sats: [{ id, label, value, accent, onPick }]; each chip is a real <button>.
  // The chips ride a tilted ring (an ellipse seen at an angle). JS places them every frame: the ones at
  // the bottom of the ellipse are "in front" (bigger, brighter, drawn over the core), the ones at the top
  // are "behind" (smaller, dimmer, hidden by the core's glass lens). Hover/focus pauses the ride.
  // The ring path is two half-ellipses so its front half can pass over the core and the back half under.
  var ORBIT_RX = 168, ORBIT_RY = 112;       // fallback ellipse radii in px; mirror.css sets --orx / --ory
  var ORBIT_PERIOD_MS = 48000;              // one full lap
  function orbit(centreEl, sats) {
    var box = el("div", "hg-orbit is-3d");
    var rx = ORBIT_RX, ry = ORBIT_RY;
    function readSize() {
      var cs = getComputedStyle(box);
      rx = parseFloat(cs.getPropertyValue("--orx")) || ORBIT_RX;
      ry = parseFloat(cs.getPropertyValue("--ory")) || ORBIT_RY;
    }
    ["is-back", "is-front"].forEach(function (k) {
      box.appendChild(el("span", "hg-orbit__ell " + k));
      box.appendChild(el("span", "hg-orbit__ell is-inner " + k));
    });
    var ring = el("div", "hg-orbit__ring");
    box.appendChild(ring);
    var centre = el("div", "hg-orbit__centre"); centre.appendChild(centreEl); box.appendChild(centre);
    var chips = {}, order = [];
    function build(list) {
      ring.textContent = ""; chips = {}; order = [];
      list.forEach(function (s) {
        var b = el("button", "hg-sat"); b.type = "button";
        b.style.setProperty("--card-accent", s.accent || "#3ee6ff");
        var v = el("span", "hg-sat__v", String(s.value)); var l = el("span", "hg-sat__l", s.label);
        b.appendChild(l); b.appendChild(v);
        b.setAttribute("aria-label", s.label + ": " + s.value + ". Open card");
        b.addEventListener("click", function (e) { e.stopPropagation(); if (s.onPick) s.onPick(); });
        ring.appendChild(b);
        chips[s.id] = { v: v, b: b, label: s.label };
        order.push(b);
      });
    }
    build(sats);

    // place every chip for a lap position `phase` (radians)
    function place(phase) {
      var n = order.length;
      for (var i = 0; i < n; i++) {
        var a = phase + (Math.PI * 2 * i) / n;
        var x = Math.cos(a) * rx, y = Math.sin(a) * ry;
        var d = (Math.sin(a) + 1) / 2;                 // 0 = far back, 1 = closest to the viewer
        var b = order[i];
        b.style.transform = "translate(-50%, -50%) translate(" + x.toFixed(1) + "px, " + y.toFixed(1) + "px) scale(" + (0.8 + 0.2 * d).toFixed(3) + ")";
        b.style.setProperty("--d", d.toFixed(3));
        b.style.zIndex = d > 0.5 ? "4" : "0";          // the core's lens sits at z-index 1
      }
    }

    // the ride: a rAF loop that keeps its own clock so pausing does not make chips jump
    var phase = Math.PI / 4, last = 0, raf = 0, paused = false, alive = true;
    var sized = false;
    function frame(t) {
      if (!alive) return;
      if (!sized && box.isConnected) { readSize(); sized = true; }   // CSS applies once the node is in the page
      if (last && !paused) phase += ((t - last) / ORBIT_PERIOD_MS) * Math.PI * 2;
      last = t;
      place(phase);
      raf = requestAnimationFrame(frame);
    }
    function pause() { paused = true; }
    function resume() { paused = box.matches(":hover") || box.contains(document.activeElement); }
    box.addEventListener("pointerenter", pause);
    box.addEventListener("pointerleave", resume);
    box.addEventListener("focusin", pause);
    box.addEventListener("focusout", function () { setTimeout(resume, 0); });
    function onResize() { readSize(); place(phase); }
    window.addEventListener("resize", onResize);
    place(phase);
    if (!reduced()) raf = requestAnimationFrame(frame);
    else requestAnimationFrame(function () { if (alive && box.isConnected) onResize(); });   // still: place once with the CSS size

    return {
      node: box,
      set: function (list) {
        list.forEach(function (s) {
          var c = chips[s.id]; if (!c) return;
          c.v.textContent = String(s.value);
          c.b.setAttribute("aria-label", c.label + ": " + s.value + ". Open card");
        });
      },
      destroy: function () { alive = false; cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); box.remove(); }
    };
  }

  // ===== 8. Fallback reactor core (only when AQ.hud.core is missing) =====
  // reactor(container, {label, value, sub}) -> { set(value, sub), destroy() }  -- same shape as AQ.hud.core
  function reactor(container, opts) {
    opts = opts || {};
    var box = el("div", "hg-core");
    var size = 220, c = size / 2;
    var s = svg("svg", { viewBox: "0 0 " + size + " " + size, "class": "hg-core__svg", "aria-hidden": "true", focusable: "false" });
    s.appendChild(svg("circle", { cx: c, cy: c, r: 104, "class": "hg-core__ring is-a" }));
    s.appendChild(svg("circle", { cx: c, cy: c, r: 92, "class": "hg-core__ring is-b" }));
    s.appendChild(svg("circle", { cx: c, cy: c, r: 78, "class": "hg-core__ring is-c" }));
    for (var i = 0; i < 12; i++) s.appendChild(svg("path", { d: arcD(c, c, 66, i * 30 + 4, i * 30 + 24), "class": "hg-core__seg" }));
    s.appendChild(svg("circle", { cx: c, cy: c, r: 52, "class": "hg-core__glow" }));
    box.appendChild(s);
    var txt = el("div", "hg-core__txt");
    txt.appendChild(el("p", "hg-core__label", opts.label || ""));
    var num = el("p", "hg-core__value"); txt.appendChild(num);
    var sub = el("p", "hg-core__sub", opts.sub || ""); txt.appendChild(sub);
    box.appendChild(txt);
    container.appendChild(box);
    var t = ticker(num);
    t.set(opts.value == null ? "0" : opts.value);
    return {
      node: box,
      set: function (value, subText) { t.set(value); if (subText != null) sub.textContent = subText; },
      destroy: function () { box.remove(); }
    };
  }

  AQ.hudGauges = { segArc: segArc, tickBar: tickBar, radar: radar, clock24: clock24, ticker: ticker, orbit: orbit, reactor: reactor };
})();

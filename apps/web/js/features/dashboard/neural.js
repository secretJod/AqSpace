/*
What: the living "neural network" layer drawn behind the dashboard cards (one <canvas>).
      Drifting nodes linked by distance-faded lines (constellation, mouse-attracted), a central
      "core" hub with curved threads to every card, and light packets flowing along those threads.
How it fits: dashboard.js mounts it once the grid is in the DOM (see the "HUD + neural layer (Dev A)"
      block in mount()). It never reads layout per frame: card rects are cached and only refreshed on
      resize / ResizeObserver. It subscribes to AQ.activity itself and fires a packet chain on new sessions.
Start reading at: section 7, mount().

AQ.neural.mount(gridEl, { cards: [{ id, el, accent }] }) -> { pulse(fromId, toId?, opts), destroy() }
  pulse("core", "today")  -> a bright burst packet from the core to the "today" card
  pulse("today", "time")  -> card-to-card burst (routed through the core)
*/
(function () {
  "use strict";
  var AQ = (window.AQ = window.AQ || {});

  // ===== 1. Tunables =====
  var FRAME_MS = 1000 / 60; // fps cap
  var LINK_DIST = 130; // max px between two nodes that get a line
  var MOUSE_DIST = 180; // radius of the mouse attraction
  var CELL = LINK_DIST; // spatial grid cell size = link distance -> only 9 cells to check
  var CHAIN = ["today", "time", "goals", "streak"]; // packet chain on a new session

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  function lowPower() {
    var small = window.innerWidth < 720;
    var weak = navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4;
    return small || weak;
  }
  function panelOpen() {
    try {
      return !!(AQ.expand && AQ.expand.isOpen && AQ.expand.isOpen());
    } catch (e) {
      return false;
    }
  }
  // "#3b82f6" -> "59,130,246" so we can build rgba() strings with any alpha
  function rgbOf(hex) {
    var h = String(hex || "#7dd3fc").replace("#", "");
    if (h.length === 3) h = h.replace(/./g, "$&$&");
    var n = parseInt(h, 16);
    if (isNaN(n)) return "125,211,252";
    return ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255);
  }

  // ===== 2. Geometry: cached rects, core position, bezier threads =====
  // Rects are relative to the layer element (which scrolls with the page), so scrolling needs no work.
  function measure(layer, cards) {
    var base = layer.getBoundingClientRect();
    return cards.map(function (c) {
      var r = c.el.getBoundingClientRect();
      return { id: c.id, rgb: rgbOf(c.accent), x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
    });
  }
  // the visual centre of all card rects
  function coreOf(rects) {
    var minX = 1e9,
      minY = 1e9,
      maxX = -1e9,
      maxY = -1e9;
    rects.forEach(function (r) {
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    });
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }
  // point on the card edge nearest to the core, plus the outward normal (for the curve's control point)
  function anchorOf(rect, core) {
    var cx = Math.max(rect.x, Math.min(core.x, rect.x + rect.w));
    var cy = Math.max(rect.y, Math.min(core.y, rect.y + rect.h));
    var inside = cx === core.x && cy === core.y;
    if (inside) return { x: rect.x + rect.w / 2, y: rect.y, nx: 0, ny: -1 };
    var dl = Math.abs(cx - rect.x),
      dr = Math.abs(cx - rect.x - rect.w),
      dt = Math.abs(cy - rect.y),
      db = Math.abs(cy - rect.y - rect.h);
    var m = Math.min(dl, dr, dt, db);
    // nudge the anchor towards the middle of that side so threads don't all hit corners
    if (m === dl || m === dr) return { x: cx, y: (cy * 2 + rect.y + rect.h / 2) / 3, nx: m === dl ? -1 : 1, ny: 0 };
    return { x: (cx * 2 + rect.x + rect.w / 2) / 3, y: cy, nx: 0, ny: m === dt ? -1 : 1 };
  }
  // a cubic bezier from the core to the anchor that leaves the card perpendicular to its edge
  function threadOf(rect, core, index) {
    var a = anchorOf(rect, core);
    var dx = a.x - core.x,
      dy = a.y - core.y,
      len = Math.sqrt(dx * dx + dy * dy) || 1;
    var bend = (index % 2 ? 1 : -1) * Math.min(90, len * 0.25); // alternate the curl direction
    return {
      id: rect.id,
      rgb: rect.rgb,
      len: len,
      p0: core,
      p1: { x: core.x + dx * 0.35 - (dy / len) * bend, y: core.y + dy * 0.35 + (dx / len) * bend },
      p2: { x: a.x + a.nx * Math.min(80, len * 0.3), y: a.y + a.ny * Math.min(80, len * 0.3) },
      p3: { x: a.x, y: a.y }
    };
  }
  function bezierAt(t, th) {
    var u = 1 - t,
      a = u * u * u,
      b = 3 * u * u * t,
      c = 3 * u * t * t,
      d = t * t * t;
    return {
      x: a * th.p0.x + b * th.p1.x + c * th.p2.x + d * th.p3.x,
      y: a * th.p0.y + b * th.p1.y + c * th.p2.y + d * th.p3.y
    };
  }

  // ===== 3. Drifting nodes + spatial grid =====
  function makeNodes(count, w, h) {
    var out = [];
    for (var i = 0; i < count; i++) {
      out.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        r: 0.8 + Math.random() * 1.4
      });
    }
    return out;
  }
  function moveNodes(nodes, w, h, mouse) {
    nodes.forEach(function (n) {
      if (mouse.active) {
        var dx = mouse.x - n.x,
          dy = mouse.y - n.y,
          d2 = dx * dx + dy * dy;
        if (d2 < MOUSE_DIST * MOUSE_DIST && d2 > 1) {
          n.vx += dx * 0.00004;
          n.vy += dy * 0.00004;
        }
      }
      n.vx *= 0.995;
      n.vy *= 0.995; // light friction keeps speeds calm
      if (Math.abs(n.vx) < 0.05) n.vx += (Math.random() - 0.5) * 0.02;
      if (Math.abs(n.vy) < 0.05) n.vy += (Math.random() - 0.5) * 0.02;
      n.x += n.vx;
      n.y += n.vy;
      if (n.x < 0 || n.x > w) n.vx *= -1;
      if (n.y < 0 || n.y > h) n.vy *= -1;
    });
  }
  // bucket nodes by cell so each node only compares with its 3x3 neighbourhood
  function buildGrid(nodes) {
    var grid = {};
    nodes.forEach(function (n, i) {
      var key = Math.floor(n.x / CELL) + ":" + Math.floor(n.y / CELL);
      (grid[key] || (grid[key] = [])).push(i);
    });
    return grid;
  }

  // Instrument palette: links/threads in steel, data packets in cyan only (data flow, not decoration).
  var STEEL = "138,155,176",
    CYAN = "95,212,255";
  // ===== 4. Drawing =====
  function drawNetwork(ctx, nodes, mouse) {
    var grid = buildGrid(nodes);
    ctx.lineWidth = 0.5;
    nodes.forEach(function (n, i) {
      var gx = Math.floor(n.x / CELL),
        gy = Math.floor(n.y / CELL);
      for (var ox = -1; ox <= 1; ox++)
        for (var oy = -1; oy <= 1; oy++) {
          var bucket = grid[gx + ox + ":" + (gy + oy)];
          if (!bucket) continue;
          for (var k = 0; k < bucket.length; k++) {
            var j = bucket[k];
            if (j <= i) continue; // each pair once
            var m = nodes[j],
              dx = n.x - m.x,
              dy = n.y - m.y,
              d = Math.sqrt(dx * dx + dy * dy);
            if (d > LINK_DIST) continue;
            ctx.strokeStyle = "rgba(" + STEEL + "," + (0.14 * (1 - d / LINK_DIST)).toFixed(3) + ")";
            ctx.beginPath();
            ctx.moveTo(n.x, n.y);
            ctx.lineTo(m.x, m.y);
            ctx.stroke();
          }
        }
    });
    // mouse constellation: brighter links to the pointer
    if (mouse.active) {
      nodes.forEach(function (n) {
        var dx = n.x - mouse.x,
          dy = n.y - mouse.y,
          d = Math.sqrt(dx * dx + dy * dy);
        if (d > MOUSE_DIST) return;
        ctx.strokeStyle = "rgba(" + STEEL + "," + (0.26 * (1 - d / MOUSE_DIST)).toFixed(3) + ")";
        ctx.beginPath();
        ctx.moveTo(n.x, n.y);
        ctx.lineTo(mouse.x, mouse.y);
        ctx.stroke();
      });
    }
    ctx.fillStyle = "rgba(" + STEEL + ",0.55)";
    nodes.forEach(function (n) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, 6.2832);
      ctx.fill();
    });
  }
  function drawThreads(ctx, threads) {
    threads.forEach(function (th) {
      ctx.strokeStyle = "rgba(" + STEEL + ",0.22)";
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(th.p0.x, th.p0.y);
      ctx.bezierCurveTo(th.p1.x, th.p1.y, th.p2.x, th.p2.y, th.p3.x, th.p3.y);
      ctx.stroke();
      // a small socket where the thread plugs into the card
      ctx.fillStyle = "rgba(" + STEEL + ",0.7)";
      ctx.fillRect(th.p3.x - 1.5, th.p3.y - 1.5, 3, 3);
    });
  }
  // Animated-Beam packet: a tail of fading dots along the curve + a glowing head
  function drawPacket(ctx, th, t, size, alpha, reverse) {
    var TAIL = 14,
      span = Math.min(0.25, 90 / th.len);
    for (var i = TAIL; i >= 0; i--) {
      var tt = t - (reverse ? -1 : 1) * span * (i / TAIL);
      if (tt < 0 || tt > 1) continue;
      var p = bezierAt(tt, th),
        fade = 1 - i / TAIL;
      ctx.fillStyle = "rgba(" + CYAN + "," + (alpha * fade * 0.55).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(p.x, p.y, size * (0.35 + 0.65 * fade), 0, 6.2832);
      ctx.fill();
    }
    var head = bezierAt(Math.max(0, Math.min(1, t)), th);
    var glow = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, size * 2.5);
    glow.addColorStop(0, "rgba(230,248,255," + alpha + ")");
    glow.addColorStop(0.3, "rgba(" + CYAN + "," + alpha * 0.7 + ")");
    glow.addColorStop(1, "rgba(" + CYAN + ",0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(head.x, head.y, size * 2.5, 0, 6.2832);
    ctx.fill();
  }
  function drawCore(ctx, core, time) {
    var breathe = 0.5 + 0.5 * Math.sin(time / 900);
    var g = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, 70);
    g.addColorStop(0, "rgba(" + CYAN + "," + (0.18 + 0.08 * breathe).toFixed(3) + ")");
    g.addColorStop(1, "rgba(" + CYAN + ",0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(core.x, core.y, 70, 0, 6.2832);
    ctx.fill();
    // two counter-rotating dashed rings
    ctx.lineWidth = 0.75;
    [
      [16, 1],
      [26, -0.6]
    ].forEach(function (ring) {
      ctx.save();
      ctx.translate(core.x, core.y);
      ctx.rotate((time / 2000) * ring[1]);
      ctx.setLineDash([1, 4]);
      ctx.strokeStyle = "rgba(" + STEEL + ",0.5)";
      ctx.beginPath();
      ctx.arc(0, 0, ring[0], 0, 6.2832);
      ctx.stroke();
      ctx.restore();
    });
    ctx.setLineDash([]);
  }

  // ===== 5. Packets (ambient + bursts) =====
  // ambient packets: one per thread, looping forever at a random speed (in "t per ms")
  function makeAmbient(threads) {
    return threads.map(function () {
      return { t: Math.random(), speed: 0.00012 + Math.random() * 0.00022, reverse: Math.random() < 0.3 };
    });
  }
  function stepAmbient(list, dt) {
    list.forEach(function (a) {
      a.t += a.speed * dt;
      if (a.t > 1.25) a.t = -0.25;
    });
  }

  // ===== 6. Canvas sizing =====
  function sizeCanvas(canvas, ctx, w, h) {
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5); // capped: a full-page canvas at 3x is costly
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ===== 7. mount() =====
  function mount(gridEl, opts) {
    opts = opts || {};
    var cards = (opts.cards || []).filter(function (c) {
      return c && c.el;
    });
    // the layer covers the grid's parent (the whole dashboard page) and scrolls with it
    var host = gridEl.parentNode || gridEl;
    host.classList.add("neural-host");
    var canvas = document.createElement("canvas");
    canvas.className = "neural";
    canvas.setAttribute("aria-hidden", "true");
    host.insertBefore(canvas, host.firstChild);
    var ctx = canvas.getContext("2d");
    if (!ctx)
      return {
        pulse: function () {},
        destroy: function () {
          canvas.remove();
        }
      };

    var still = reducedMotion();
    var side = 0; // canvas bleeds into the page margins by this much
    var W = 0,
      H = 0,
      rects = [],
      core = { x: 0, y: 0 },
      threads = [],
      byId = {},
      ambient = [],
      nodes = [];
    var bursts = []; // { th, t, speed, reverse, onDone }
    var mouse = { x: 0, y: 0, active: false };
    var raf = 0,
      last = 0,
      alive = true;

    function relayout() {
      // bleed into the side margins so the network fills the whole window, not just the content column
      side = Math.max(0, Math.min(400, Math.round(host.getBoundingClientRect().left)));
      W = host.clientWidth + side * 2;
      H = host.scrollHeight;
      sizeCanvas(canvas, ctx, W, H);
      canvas.style.left = -side + "px";
      rects = measure(host, cards).map(function (r) {
        r.x += side;
        return r;
      });
      core = rects.length ? coreOf(rects) : { x: W / 2, y: H / 2 };
      threads = rects.map(function (r, i) {
        return threadOf(r, core, i);
      });
      byId = {};
      threads.forEach(function (th) {
        byId[th.id] = th;
      });
      ambient = makeAmbient(threads);
      var want = lowPower() ? 55 : Math.min(120, Math.round((W * H) / 16000));
      if (nodes.length !== want) nodes = makeNodes(want, W, H);
      if (still) draw(0);
    }

    function draw(time) {
      ctx.clearRect(0, 0, W, H);
      drawNetwork(ctx, nodes, mouse);
      drawThreads(ctx, threads);
      if (!still) {
        ctx.globalCompositeOperation = "lighter"; // additive glow for the light packets
        threads.forEach(function (th, i) {
          var a = ambient[i];
          drawPacket(ctx, th, a.t, 2, 0.75, a.reverse);
        });
        bursts.forEach(function (b) {
          drawPacket(ctx, b.th, b.t, 3.6, 1, b.reverse);
        });
        ctx.globalCompositeOperation = "source-over";
      }
      drawCore(ctx, core, time);
    }

    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (document.hidden || panelOpen()) {
        last = now;
        return;
      } // paused: keep the loop cheap
      if (now - last < FRAME_MS - 1) return;
      var dt = Math.min(64, now - (last || now));
      last = now;
      moveNodes(nodes, W, H, mouse);
      stepAmbient(ambient, dt);
      bursts = bursts.filter(function (b) {
        b.t += (b.reverse ? -1 : 1) * b.speed * dt;
        var done = b.reverse ? b.t < 0 : b.t > 1;
        if (done && b.onDone) b.onDone();
        return !done;
      });
      draw(now);
    }

    // 7a. bursts: core -> card runs forward; card -> card is card -> core (reverse) then core -> card
    function burst(th, reverse, onDone) {
      if (!th || still) {
        if (onDone) onDone();
        return;
      }
      bursts.push({
        th: th,
        t: reverse ? 1 : 0,
        speed: 1 / Math.max(450, th.len * 2.2),
        reverse: reverse,
        onDone: onDone
      });
    }
    function pulse(fromId, toId, popts) {
      popts = popts || {};
      if (!toId) {
        toId = fromId;
        fromId = "core";
      }
      var done = popts.onArrive || null;
      if (fromId === "core") return burst(byId[toId], false, done);
      burst(byId[fromId], true, function () {
        burst(byId[toId], false, done);
      });
    }
    function chain(ids) {
      var prev = "core";
      (function next(i) {
        if (i >= ids.length || !alive) return;
        var id = ids[i],
          from = prev;
        prev = id;
        pulse(from, id, {
          onArrive: function () {
            next(i + 1);
          }
        });
      })(0);
    }

    // 7b. listeners
    function onMove(e) {
      var b = canvas.getBoundingClientRect(); // one read per pointer event, not per frame
      mouse.x = e.clientX - b.left; // canvas coords already include `side` mouse.y = e.clientY - b.top; mouse.active = true;
    }
    function onLeave() {
      mouse.active = false;
    }
    var resizeTimer = 0;
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(relayout, 120);
    }
    var ro = window.ResizeObserver ? new ResizeObserver(onResize) : null;
    if (ro) {
      ro.observe(host);
      cards.forEach(function (c) {
        ro.observe(c.el);
      });
    }
    window.addEventListener("resize", onResize);
    if (!still) {
      host.addEventListener("pointermove", onMove);
      host.addEventListener("pointerleave", onLeave);
    }
    var unsub = null;
    try {
      if (AQ.activity && AQ.activity.subscribe)
        unsub = AQ.activity.subscribe(function (evt) {
          if (evt && evt.type === "log") chain(CHAIN);
        });
    } catch (e) {
      unsub = null;
    }

    relayout();
    if (!still) raf = requestAnimationFrame(frame);
    // a welcome chain once the reveal animation has settled
    var hello = setTimeout(
      function () {
        relayout();
        chain(CHAIN);
      },
      still ? 0 : 900
    );

    return {
      pulse: pulse,
      chain: chain,
      destroy: function () {
        alive = false;
        cancelAnimationFrame(raf);
        clearTimeout(resizeTimer);
        clearTimeout(hello);
        if (ro) ro.disconnect();
        window.removeEventListener("resize", onResize);
        host.removeEventListener("pointermove", onMove);
        host.removeEventListener("pointerleave", onLeave);
        if (typeof unsub === "function")
          try {
            unsub();
          } catch (e) {
            /* ignore */
          }
        host.classList.remove("neural-host");
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };
  }

  AQ.neural = { mount: mount };
})();

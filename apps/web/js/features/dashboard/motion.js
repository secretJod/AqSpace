/* =====================================================================================================
   What this file does:
     Small "premium" motion effects for dashboard cards: a pointer-tracked spotlight, a subtle 3D tilt,
     a staggered entrance reveal, a count-up for numbers and a slow aurora background.

   How it fits:
     dashboard.js applies these to its cards (`AQ.motion.spotlight(card)`, `AQ.motion.tilt(card)` ...),
     streak.js uses spotlight on its compact card. Only CSS variables / classes are set here, the look
     lives in css/motion.css. Needs nothing else; load before the files that use it.

   Start reading at:
     `spotlight()` (section 2) - the other effects follow the same shape: attach listeners, return destroy().
   ===================================================================================================== */

/* AQspace - motion helpers.
   AQ.motion.spotlight(el)              -> { destroy() }   sets --mx / --my (px) on the element
   AQ.motion.tilt(el, { max: 4 })       -> { destroy() }   sets --mo-rx / --mo-ry (deg)
   AQ.motion.reveal(container, { selector }) -> { destroy() }  staggered entrance of the children
   AQ.motion.countUp(el, to, { duration, format }) -> { cancel() }
   AQ.motion.aurora(container)          -> { destroy() }   adds a slow gradient layer behind the content */
window.AQ = window.AQ || {};
(function (AQ) {
  "use strict";

  // ===== 1. Shared helpers =====
  function reducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }
  function coarsePointer() {
    try {
      return window.matchMedia("(hover: none)").matches;
    } catch {
      return false;
    }
  }
  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }
  // Runs `fn` at most once per animation frame with the latest arguments (no layout thrash on pointermove).
  function frameThrottle(fn) {
    var queued = false,
      lastArgs = null;
    function run() {
      queued = false;
      fn.apply(null, lastArgs);
    }
    var throttled = function () {
      lastArgs = arguments;
      if (!queued) {
        queued = true;
        requestAnimationFrame(run);
      }
    };
    throttled.cancel = function () {
      queued = false;
    };
    return throttled;
  }

  // ===== 2. Spotlight: a radial highlight that follows the pointer over the card =====
  function spotlight(node) {
    node.classList.add("mo-spot");
    var glow = el("i", "mo-spot__glow"),
      ring = el("i", "mo-spot__ring");
    glow.setAttribute("aria-hidden", "true");
    ring.setAttribute("aria-hidden", "true");
    node.appendChild(glow);
    node.appendChild(ring);

    var move = frameThrottle(function (x, y) {
      var r = node.getBoundingClientRect();
      node.style.setProperty("--mx", x - r.left + "px");
      node.style.setProperty("--my", y - r.top + "px");
    });
    function onMove(e) {
      move(e.clientX, e.clientY);
    }
    function onEnter() {
      node.classList.add("mo-spot--on");
    }
    function onLeave() {
      node.classList.remove("mo-spot--on");
      move.cancel();
    }
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerenter", onEnter);
    node.addEventListener("pointerleave", onLeave);
    return {
      destroy: function () {
        node.removeEventListener("pointermove", onMove);
        node.removeEventListener("pointerenter", onEnter);
        node.removeEventListener("pointerleave", onLeave);
        node.classList.remove("mo-spot", "mo-spot--on");
        glow.remove();
        ring.remove();
      }
    };
  }

  // ===== 3. Tilt: the card leans a few degrees toward the pointer and springs back on leave =====
  function tilt(node, opts) {
    opts = opts || {};
    var max = +opts.max || 4;
    if (reducedMotion() || coarsePointer()) return { destroy: function () {} };
    node.classList.add("mo-tilt");

    var move = frameThrottle(function (x, y) {
      var r = node.getBoundingClientRect();
      var px = (x - r.left) / r.width - 0.5; // -0.5 .. 0.5
      var py = (y - r.top) / r.height - 0.5;
      node.style.setProperty("--mo-ry", (px * max * 2).toFixed(2) + "deg");
      node.style.setProperty("--mo-rx", (-py * max * 2).toFixed(2) + "deg");
    });
    function onMove(e) {
      if (e.pointerType === "touch") return;
      move(e.clientX, e.clientY);
    }
    function onEnter() {
      node.classList.add("mo-tilt--live");
    }
    function onLeave() {
      move.cancel();
      node.classList.remove("mo-tilt--live"); // the CSS spring (transition) brings it back
      node.style.setProperty("--mo-rx", "0deg");
      node.style.setProperty("--mo-ry", "0deg");
    }
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerenter", onEnter);
    node.addEventListener("pointerleave", onLeave);
    return {
      destroy: function () {
        node.removeEventListener("pointermove", onMove);
        node.removeEventListener("pointerenter", onEnter);
        node.removeEventListener("pointerleave", onLeave);
        node.classList.remove("mo-tilt", "mo-tilt--live");
        node.style.removeProperty("--mo-rx");
        node.style.removeProperty("--mo-ry");
      }
    };
  }

  // ===== 4. Reveal: children fade/blur in one after another as they scroll into view =====
  function reveal(container, opts) {
    opts = opts || {};
    var items = Array.prototype.slice.call(container.querySelectorAll(opts.selector || ".dash__card"));
    if (reducedMotion() || typeof IntersectionObserver !== "function") return { destroy: function () {} };
    items.forEach(function (n, i) {
      n.classList.add("mo-reveal");
      n.style.setProperty("--mo-i", String(i));
    });
    // Plays the entrance, then removes the reveal classes so no filter layer stays on the card
    // (a lingering filter blurs big cards with running animations in some Chrome builds).
    function showItem(n) {
      if (n.classList.contains("mo-reveal--in")) return;
      n.classList.add("mo-reveal--in");
      var delay = 700 + (+n.style.getPropertyValue("--mo-i") || 0) * 70 + 80;
      setTimeout(function () {
        n.classList.remove("mo-reveal", "mo-reveal--in");
        n.style.removeProperty("--mo-i");
      }, delay);
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          showItem(en.target);
          io.unobserve(en.target);
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 }
    );
    items.forEach(function (n) {
      io.observe(n);
    });
    // safety net: whatever did not intersect (hidden tabs, odd layouts) shows after a moment
    var fallback = setTimeout(function () {
      items.forEach(showItem);
    }, 2500);
    return {
      destroy: function () {
        clearTimeout(fallback);
        io.disconnect();
        items.forEach(function (n) {
          n.classList.remove("mo-reveal", "mo-reveal--in");
          n.style.removeProperty("--mo-i");
        });
      }
    };
  }

  // ===== 5. Count-up: tween the number shown in an element =====
  function countUp(node, to, opts) {
    opts = opts || {};
    var duration = +opts.duration || 900;
    var format =
      typeof opts.format === "function"
        ? opts.format
        : function (v) {
            return String(Math.round(v));
          };
    to = +to || 0;
    // start from the number currently shown (so refreshes tween, not jump), else from 0
    var from = parseFloat(String(node.textContent).replace(/[^\d.-]/g, ""));
    if (isNaN(from)) from = 0;
    if (reducedMotion() || from === to) {
      node.textContent = format(to);
      return { cancel: function () {} };
    }
    var t0 = 0,
      raf = 0;
    function step(ts) {
      if (!t0) t0 = ts;
      var p = Math.min(1, (ts - t0) / duration);
      var eased = 1 - Math.pow(2, -10 * p); // ease-out expo (snaps to the end)
      if (p >= 1) eased = 1;
      node.textContent = format(from + (to - from) * eased);
      if (p < 1 && node.isConnected) raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return {
      cancel: function () {
        cancelAnimationFrame(raf);
        node.textContent = format(to);
      }
    };
  }

  // ===== 6. Aurora: a slow, blurred gradient layer behind the grid =====
  function aurora(container) {
    container.classList.add("mo-aurora-host");
    var layer = el("div", "mo-aurora");
    layer.setAttribute("aria-hidden", "true");
    for (var i = 1; i <= 3; i++) layer.appendChild(el("i", "mo-aurora__blob mo-aurora__blob--" + i));
    container.insertBefore(layer, container.firstChild);
    return {
      destroy: function () {
        layer.remove();
        container.classList.remove("mo-aurora-host");
      }
    };
  }

  // ===== 7. Public API =====
  AQ.motion = {
    spotlight: spotlight,
    tilt: tilt,
    reveal: reveal,
    countUp: countUp,
    aurora: aurora,
    reducedMotion: reducedMotion
  };
})(window.AQ);

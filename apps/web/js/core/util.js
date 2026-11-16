/* =====================================================================================================
   util.js - small shared helpers (AQ.util)

   What this file does:
     Builds DOM elements and icons, reads YouTube ids from links, and formats durations
     ("17:05", "2 hr 43 min") and relative dates ("3 days ago").

   How it fits:
     The first app script after demo-cleanup.js. It creates the global `window.AQ` namespace that every
     other file hangs its piece on (AQ.store, AQ.api, AQ.dialog, ...). Depends on nothing.
     Other files usually start with `var u = AQ.util, el = u.el;`.

   Security:
     Every helper that puts text on the page uses textContent, never innerHTML, so playlist names, video
     titles and other user or server data can never be interpreted as markup.

   Start reading at:
     `el()` at the top, `icon()` (section 1), then `parseYouTubeId()` (section 2).
     Next file: core/store.js, the data store built on these helpers.
   ===================================================================================================== */
window.AQ = window.AQ || {};
(function () {
  "use strict";

  var ID_RE = /^[A-Za-z0-9_-]{11}$/;

  /**
   * Shorthand for querySelector.
   * @param {string} sel CSS selector.
   * @param {ParentNode} [root=document] Where to search.
   * @returns {Element|null}
   */
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  /**
   * Create an element. Text is always set with textContent (never innerHTML), so data is never parsed as HTML.
   * @param {string} tag Tag name.
   * @param {string} [cls] Class attribute.
   * @param {string|number} [text] Text content.
   * @returns {HTMLElement}
   */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ===== 1. icons (stroke icons drawn with DOM APIs) =====
  var SVG_NS = "http://www.w3.org/2000/svg";
  var ICONS = {
    play: { d: "M8 5v14l11-7z", fill: true },
    dots: { d: "M5 12h.01M12 12h.01M19 12h.01", thick: true },
    plus: { d: "M12 5v14M5 12h14" },
    back: { d: "M19 12H5M12 19l-7-7 7-7" },
    up: { d: "M6 15l6-6 6 6" },
    down: { d: "M6 9l6 6 6-6" },
    grip: { d: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01", thick: true },
    trash: { d: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" },
    pencil: { d: "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" },
    notes: { d: "M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6M8 13h8M8 17h6" },
    external: { d: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" },
    search: { d: "M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-4.3-4.3" },
    user: { d: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 3a4 4 0 100 8 4 4 0 000-8z" },
    youtube: { d: "M3 8a3 3 0 013-3h12a3 3 0 013 3v8a3 3 0 01-3 3H6a3 3 0 01-3-3zM10 9.5v5l4.5-2.5z" },
    list: { d: "M3 6h13M3 12h13M3 18h6M15 15v6l5-3z" },
    prev: { d: "M19 4L9 12l10 8zM5 5v14" },
    next: { d: "M5 4l10 8-10 8zM19 5v14" }
  };
  /**
   * Build one of the stroke icons above as an inline <svg>. Icons are decorative: aria-hidden and not
   * focusable, so screen readers read the button label instead.
   * @param {string} name A key of ICONS; unknown names fall back to "play".
   * @returns {SVGSVGElement}
   */
  function icon(name) {
    var spec = ICONS[name] || ICONS.play;
    var s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("focusable", "false");
    s.setAttribute("class", "icon");
    var p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", spec.d);
    if (spec.fill) {
      p.setAttribute("fill", "currentColor");
    } else {
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "currentColor");
      p.setAttribute("stroke-width", spec.thick ? "3" : "2");
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
    }
    s.appendChild(p);
    return s;
  }

  /**
   * Build a <button>.
   * @param {string} [label] Visible text.
   * @param {{cls?: string, icon?: string, type?: string, aria?: string, title?: string}} [opts]
   *   `aria` sets aria-label (needed for icon-only buttons); `type` defaults to "button" so it never submits a form.
   * @returns {HTMLButtonElement}
   */
  function button(label, opts) {
    opts = opts || {};
    var b = el("button", opts.cls || "btn");
    b.type = opts.type || "button";
    if (opts.icon) b.appendChild(icon(opts.icon));
    if (label) b.appendChild(el("span", null, label));
    if (opts.aria) b.setAttribute("aria-label", opts.aria);
    if (opts.title) b.title = opts.title;
    return b;
  }

  // ===== 2. YouTube =====
  /**
   * Extract a validated 11-character YouTube id from a URL or a bare id.
   * Only ids matching ID_RE are returned, so the result is safe to put into embed and thumbnail URLs.
   * @param {string} input A youtube.com / youtu.be / shorts / embed link, or an id.
   * @returns {string|null} The id, or null when the input is not a YouTube video.
   */
  function parseYouTubeId(input) {
    var s = String(input || "").trim();
    if (!s) return null;
    if (ID_RE.test(s)) return s;
    var u;
    try {
      u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s);
    } catch {
      return null;
    }
    var host = u.hostname.replace(/^www\.|^m\./, "").toLowerCase();
    var id = null;
    if (host === "youtu.be") id = u.pathname.split("/")[1];
    else if (host === "youtube.com" || host === "youtube-nocookie.com" || host === "music.youtube.com") {
      if (u.pathname === "/watch") id = u.searchParams.get("v");
      else {
        var m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
        if (m) id = m[2];
      }
    }
    return id && ID_RE.test(id) ? id : null;
  }
  /**
   * @param {string} id A validated video id.
   * @returns {string} The youtube.com watch page URL.
   */
  function watchUrl(id) {
    return "https://www.youtube.com/watch?v=" + id;
  }
  function thumbUrl(id) {
    return "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg";
  }

  /**
   * An <img> for a video thumbnail. Lazy-loaded, empty alt (the title next to it is the label), and it
   * hides itself if the image fails to load.
   * @param {string} id A validated video id.
   * @returns {HTMLImageElement}
   */
  function thumbImg(id) {
    var img = el("img");
    img.src = thumbUrl(id);
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", function () {
      img.style.visibility = "hidden";
    });
    return img;
  }

  // ===== 3. durations =====
  var DUR_RE = /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)$/;
  /**
   * Parse "1:56:20" or "17:05" into seconds.
   * @param {string} s
   * @returns {number|null} Seconds, or null when it is not a valid duration.
   */
  function parseDuration(s) {
    var m = DUR_RE.exec(String(s || "").trim());
    if (!m) return null;
    return (m[1] ? +m[1] : 0) * 3600 + +m[2] * 60 + +m[3];
  }
  /**
   * Normalise user input to "m:ss" or "h:mm:ss".
   * @param {string} s
   * @returns {string} The normalised duration, or "" when invalid or empty.
   */
  function normDuration(s) {
    var sec = parseDuration(s);
    if (sec == null) return "";
    var h = Math.floor(sec / 3600),
      m = Math.floor((sec % 3600) / 60),
      x = sec % 60;
    return h ? h + ":" + pad(m) + ":" + pad(x) : m + ":" + pad(x);
  }
  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }
  /**
   * Format seconds as "45 min" or "2 hr 43 min" (never less than "1 min").
   * @param {number} sec
   * @returns {string}
   */
  function humanDuration(sec) {
    var m = Math.round(sec / 60);
    if (m < 1) return "1 min";
    if (m < 60) return m + " min";
    var h = Math.floor(m / 60),
      r = m % 60;
    return h + " hr" + (r ? " " + r + " min" : "");
  }

  /**
   * Count the videos of a playlist and add up their durations.
   * @param {{videos: Array<{duration: string}>}} p A playlist.
   * @returns {{count: number, seconds: number, unknown: number}} `unknown` = videos without a valid duration.
   */
  function stats(p) {
    var sec = 0,
      unknown = 0;
    p.videos.forEach(function (v) {
      var s = parseDuration(v.duration);
      if (s == null) unknown++;
      else sec += s;
    });
    return { count: p.videos.length, seconds: sec, unknown: unknown };
  }
  /**
   * Summary line for a playlist card: "3 videos · 1 hr 12 min" (a trailing "+" when some durations are unknown).
   * @param {{videos: Array<{duration: string}>}} p A playlist.
   * @returns {string}
   */
  function statsText(p) {
    var st = stats(p);
    var t = st.count + (st.count === 1 ? " video" : " videos");
    if (st.seconds > 0) t += " · " + humanDuration(st.seconds) + (st.unknown ? "+" : "");
    return t;
  }

  /**
   * Relative date: "just now", "5 min ago", "2 days ago", then a short local date after 30 days.
   * @param {string} iso An ISO date string.
   * @returns {string} "" when the date cannot be parsed.
   */
  function timeAgo(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return "";
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) {
      var h = Math.floor(s / 3600);
      return h + (h === 1 ? " hour ago" : " hours ago");
    }
    if (s < 86400 * 30) {
      var d = Math.floor(s / 86400);
      return d + (d === 1 ? " day ago" : " days ago");
    }
    try {
      return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch {
      return new Date(t).toDateString();
    }
  }

  AQ.util = {
    $: $,
    el: el,
    icon: icon,
    button: button,
    ID_RE: ID_RE,
    parseYouTubeId: parseYouTubeId,
    watchUrl: watchUrl,
    thumbImg: thumbImg,
    parseDuration: parseDuration,
    normDuration: normDuration,
    humanDuration: humanDuration,
    stats: stats,
    statsText: statsText,
    timeAgo: timeAgo
  };
})();

/* AQspace - profile menu, Google sign-in screen and expired-session screen (#130).
   Contract (aq-api, #151):
     GET  /api/v1/auth/status -> {authMode:"local"|"google", signedIn, user:{id,name,email,picture}|null, loginUrl}
     POST /api/v1/auth/logout -> {ok:true}
     any call may return 401 {code:"auth_required"}; api.js catches it once and calls AQ.profile.authRequired().
   While the status is unknown, <html> has .auth-pending (profile.css hides the app) so a signed-out user never sees it flash.
   User data (name, email, picture URL) is untrusted: textContent / setAttribute only, never innerHTML. */
(function () {
  "use strict";
  var root = document.documentElement;
  root.classList.add("auth-pending");

  var status = null;           // last /auth/status reply
  var screenEl = null;         // sign-in / expired overlay
  var NS = "http://www.w3.org/2000/svg";

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function reveal() { root.classList.remove("auth-pending"); }

  /* ---------- sign-in URL: relative only, returns the user to where they were ---------- */
  function loginHref() {
    var url = (status && status.loginUrl) || "/api/v1/auth/google/login";
    if (!/^\/(?!\/)/.test(url)) url = "/api/v1/auth/google/login";      // never follow an absolute / protocol-relative URL
    var base = (window.AQ && AQ.api && AQ.api.base) || "";
    return base + url + "?next=" + encodeURIComponent(location.pathname + location.hash);
  }

  /* ---------- Google "G" (official 4-colour mark, per Google's sign-in branding guidelines) ---------- */
  function googleG() {
    var s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 48 48"); s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false");
    s.setAttribute("class", "gbtn__logo");
    [
      ["#EA4335", "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"],
      ["#4285F4", "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"],
      ["#FBBC05", "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"],
      ["#34A853", "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"]
    ].forEach(function (p) {
      var e = document.createElementNS(NS, "path");
      e.setAttribute("fill", p[0]); e.setAttribute("d", p[1]);
      s.appendChild(e);
    });
    return s;
  }

  /* ---------- full-page sign-in / expired screen ---------- */
  function showScreen(expired) {
    var kind = expired ? "expired" : "signin";
    if (screenEl && screenEl.dataset.kind === kind) return;
    if (screenEl) screenEl.remove();
    closeMenu(false);
    if (window.AQ && AQ.dialog && AQ.dialog.isOpen && AQ.dialog.isOpen()) { try { AQ.dialog.close(); } catch (e) { /* ignore */ } }
    Array.prototype.forEach.call(document.body.children, function (c) { if (c.tagName !== "SCRIPT") c.inert = true; });

    screenEl = h("div", "authscreen");
    screenEl.dataset.kind = kind;
    var card = h("section", "authcard");
    card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "auth-title"); card.setAttribute("aria-describedby", "auth-desc");

    var brand = h("div", "authcard__brand");
    var mark = h("span", "logo__mark", "AQ"); mark.setAttribute("aria-hidden", "true");
    brand.appendChild(mark); brand.appendChild(h("span", "authcard__name", "AQspace"));
    card.appendChild(brand);

    var title = h("h1", "authcard__title", expired ? "Your session has ended" : "Welcome to AQspace");
    title.id = "auth-title";
    var desc = h("p", "authcard__desc", expired
      ? "Sign in again to pick up right where you left off."
      : "Sign in to see your playlists, progress and notes.");
    desc.id = "auth-desc";
    card.appendChild(title); card.appendChild(desc);

    var btn = h("a", "gbtn");
    btn.href = loginHref();
    btn.appendChild(googleG());
    btn.appendChild(h("span", "gbtn__text", "Sign in with Google"));
    btn.addEventListener("click", function () { btn.href = loginHref(); });   // keep `next` current
    card.appendChild(btn);

    screenEl.appendChild(card);
    document.body.appendChild(screenEl);
    reveal();
    btn.focus();
  }

  /* ---------- profile button + menu ---------- */
  var wrap = null, trigger = null, menu = null;

  function initials(u) {
    var src = (u && (u.name || u.email)) || "";
    var parts = String(src).replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
    var s = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || "").slice(0, 2);
    return s.toUpperCase();
  }
  function safePicture(url) { return typeof url === "string" && /^https:\/\//i.test(url) ? url : null; }

  function personIcon() {
    var s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "icon"); s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false");
    var p = document.createElementNS(NS, "path");
    p.setAttribute("d", "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 3a4 4 0 100 8 4 4 0 000-8z");
    p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "2");
    p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
    s.appendChild(p);
    return s;
  }

  function avatarFace(u) {
    var face = h("span", "profile__face");
    face.setAttribute("aria-hidden", "true");
    var ini = initials(u);
    var fallback = ini ? h("span", "profile__initials", ini) : personIcon();
    var pic = u && safePicture(u.picture);
    if (pic) {
      var img = h("img", "profile__img");
      img.alt = ""; img.width = 36; img.height = 36; img.decoding = "async";
      img.referrerPolicy = "no-referrer";                 // Google photo URLs often refuse requests that carry a Referer
      img.addEventListener("error", function () { img.remove(); face.appendChild(fallback); });
      img.src = pic;
      face.appendChild(img);
    } else face.appendChild(fallback);
    return face;
  }

  function items() { return menu ? Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]')) : []; }

  function openMenu(last) {
    if (!menu) return;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    var it = items();
    if (it.length) it[last ? it.length - 1 : 0].focus(); else menu.focus();
    document.addEventListener("pointerdown", outside, true);
  }
  function closeMenu(refocus) {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    if (refocus) trigger.focus();
  }
  function outside(e) { if (wrap && !wrap.contains(e.target)) closeMenu(false); }

  function signOut() {
    closeMenu(false);
    AQ.api.flush().catch(function () { /* ignore */ }).then(function () {
      return AQ.api.request("POST", "/api/v1/auth/logout", {}, { authFree: true });
    }).catch(function () { /* the session ends server-side or expires anyway */ }).then(function () {
      location.reload();                                 // status now says signedIn:false -> sign-in screen
    });
  }

  function buildProfile(st) {
    var slot = document.querySelector(".topbar .avatar");
    if (!slot) return;
    var u = st && st.user;
    var google = st && st.authMode === "google";

    wrap = h("div", "profile");
    trigger = h("button", "profile__btn");
    trigger.type = "button";
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", "profile-menu");
    trigger.setAttribute("aria-label", u && u.name ? "Account: " + u.name : "Account");
    trigger.appendChild(avatarFace(u));

    menu = h("div", "profile__menu");
    menu.id = "profile-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Account");
    menu.tabIndex = -1;
    menu.hidden = true;

    var head = h("div", "profile__head");
    head.appendChild(h("p", "profile__name", (u && u.name) || (google ? "Signed in" : "Local user")));
    if (u && u.email) head.appendChild(h("p", "profile__email", u.email));
    menu.appendChild(head);

    if (google) {
      menu.appendChild(h("hr", "profile__sep"));
      var out = h("button", "profile__item", "Sign out");
      out.type = "button";
      out.setAttribute("role", "menuitem");
      out.tabIndex = -1;
      out.addEventListener("click", signOut);
      menu.appendChild(out);
    } else {
      menu.appendChild(h("p", "profile__note", "Single-user mode (sign-in is off)"));
    }

    trigger.addEventListener("click", function () { if (menu.hidden) openMenu(false); else closeMenu(true); });
    trigger.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openMenu(e.key === "ArrowUp"); }
    });
    menu.addEventListener("keydown", function (e) {
      var it = items(), i = it.indexOf(document.activeElement);
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
      else if (e.key === "Tab") closeMenu(false);
      else if (it.length && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End")) {
        e.preventDefault();
        var n = e.key === "Home" ? 0 : e.key === "End" ? it.length - 1
          : e.key === "ArrowDown" ? (i + 1) % it.length : (i - 1 + it.length) % it.length;
        it[n].focus();
      }
    });

    wrap.appendChild(trigger); wrap.appendChild(menu);
    slot.replaceWith(wrap);
  }

  /* ---------- start ---------- */
  function fetchStatus() {
    if (!window.AQ || !AQ.api || !AQ.api.request) return Promise.resolve(null);
    return AQ.api.request("GET", "/api/v1/auth/status", undefined, { authFree: true, timeout: 5000 })
      .then(function (r) { return r.status === 200 && r.json ? r.json : null; }, function () { return null; });
  }

  function start() {
    // api.ready() resolves after server detection, so AQ.api.base (same origin or 127.0.0.1:5180) is known.
    var ready = window.AQ && AQ.api && AQ.api.ready ? AQ.api.ready() : Promise.resolve(false);
    ready.then(fetchStatus).then(function (st) {
      status = st || { authMode: "local", signedIn: false, user: null };
      buildProfile(status);
      if (status.authMode === "google" && !status.signedIn) showScreen(false);    // first visit: sign-in screen, app stays hidden
      else if (AQ.api && AQ.api.signedOut && AQ.api.signedOut()) showScreen(true);
      else reveal();
    });
  }

  window.AQ = window.AQ || {};
  AQ.profile = {
    /** api.js calls this once, on the first 401 auth_required. Before the status is known, start() decides instead. */
    authRequired: function () { if (status) showScreen(true); }
  };
  start();
})();

/* =====================================================================================================
   storage.js - browser storage kept separate per signed-in account (AQ.storage)

   What this file does:
     The one place the app reads and writes localStorage. Every feature names its data with a fixed key
     ("aq.playlists.v1", "aq.goals.v1", ...) and this file decides where that key really lives:

       local mode (sign-in off)      aq.playlists.v1            the keys every single-user install has today
       Google mode, signed in        aq.u<userId>.playlists.v1  one namespace per account
       Google mode, signed out       memory only                nothing is read, nothing is kept
       account not known yet         memory only                same as signed out

   Why:
     With Google sign-in several people can share one browser. Without separate namespaces the second
     person would see the first person's streak, goals, sticky notes and playlists, and api.js could
     upload the first person's offline edits into the second person's server account. Each account's data
     stays in its own namespace for its next visit; nothing is copied or moved between namespaces.

   How it fits:
     Loaded first, before boot.js. boot.js asks the server who is signed in (GET /api/v1/auth/status) and
     calls AQ.storage.useAccount(status) exactly once, and only then loads the rest of the app. Using the
     storage before that throws, so a feature that reads too early fails loudly instead of reading the
     wrong person's data. api.js uses AQ.storage.matches(status) to check the account has not changed
     before it syncs.

   Public API:
     AQ.storage.useAccount(status)  pick the namespace from an /auth/status reply (null = no server found)
     AQ.storage.matches(status)     -> boolean   whether a newer /auth/status reply is still the same account
     AQ.storage.key(name)           -> string    the real localStorage key behind a feature key
     AQ.storage.get(name)           -> string|null   like localStorage.getItem
     AQ.storage.set(name, value)    like localStorage.setItem (throws when storage is blocked or full)
     AQ.storage.remove(name)        like localStorage.removeItem

   Start reading at:
     `useAccount()`. Next file: core/boot.js.
   ===================================================================================================== */
window.AQ = window.AQ || {};
(function () {
  "use strict";

  var LOCAL = "local"; // sign-in is off: keep today's keys
  var NOBODY = "nobody"; // Google mode and nobody signed in, or the account is unknown: memory only

  var account = null; // null until useAccount() ran, then LOCAL, NOBODY or "u<id>"
  var memory = {}; // the store behind the NOBODY namespace; gone with the page

  /* An account id becomes part of a key name, so anything that is not a plain letter, digit, "_" or "-" is
     escaped. Escaping "." too keeps "aq.u<id>.<name>" unambiguous whatever the id looks like. */
  function safeId(id) {
    return String(id).replace(/[^A-Za-z0-9_-]/g, function (c) {
      return "%" + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function accountOf(status) {
    if (!status) return null;
    if (status.authMode !== "google") return LOCAL;
    if (status.signedIn && status.user && status.user.id != null && String(status.user.id) !== "")
      return "u" + safeId(status.user.id);
    return NOBODY;
  }

  function need() {
    if (account === null) {
      var err = new Error("AQ.storage was used before the signed-in account was known");
      try {
        console.error("[AQ] " + err.message);
      } catch {
        /* no console */
      }
      throw err;
    }
  }

  /**
   * The real localStorage key for a feature key. Feature keys start with "aq." ("aq.goals.v1").
   * @param {string} name Feature key.
   * @returns {string} The key itself in local mode, "aq.u<id>.<rest>" for a signed-in Google account, and a
   *   memory-only name otherwise (it never matches a localStorage key, so `storage` events from other tabs are ignored).
   */
  function key(name) {
    need();
    var rest = String(name).replace(/^aq\./, "");
    if (account === LOCAL) return String(name);
    if (account === NOBODY) return "memory:" + rest;
    return "aq." + account + "." + rest;
  }

  var storage = {
    /**
     * Pick the namespace for this page. Called once by boot.js, before any feature loads.
     * @param {{authMode: string, signedIn: boolean, user: ?{id: *}}|null} status The /auth/status reply, or null
     *   when no API server was found (the app then runs offline with the local-mode keys, as it always has).
     * @param {boolean} [serverFound] True when a server answered the health check. A server that was found but
     *   did not say who is signed in gets the memory-only namespace: we cannot tell whose data this browser holds.
     */
    useAccount: function (status, serverFound) {
      if (account !== null) return;
      account = accountOf(status) || (serverFound ? NOBODY : LOCAL);
    },
    /**
     * Whether an /auth/status reply describes the account this page is using. False while the account is
     * unknown, so a page that started without knowing it never syncs.
     * @param {object} status A fresh /auth/status reply.
     * @returns {boolean}
     */
    matches: function (status) {
      var now = accountOf(status);
      return account !== null && now !== null && now === account;
    },
    key: key,
    /**
     * @param {string} name Feature key.
     * @returns {string|null} The stored value, or null. Throws like localStorage when storage is blocked.
     */
    get: function (name) {
      var k = key(name);
      if (account === NOBODY) return Object.prototype.hasOwnProperty.call(memory, k) ? memory[k] : null;
      return window.localStorage.getItem(k);
    },
    /**
     * @param {string} name Feature key.
     * @param {string} value Value to store. Throws like localStorage when storage is blocked or full.
     */
    set: function (name, value) {
      var k = key(name);
      if (account === NOBODY) memory[k] = String(value);
      else window.localStorage.setItem(k, value);
    },
    /**
     * @param {string} name Feature key. Throws like localStorage when storage is blocked.
     */
    remove: function (name) {
      var k = key(name);
      if (account === NOBODY) delete memory[k];
      else window.localStorage.removeItem(k);
    }
  };

  AQ.storage = storage;
})();

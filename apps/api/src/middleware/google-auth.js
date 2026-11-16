/* google-auth.js - Google sign-in (OAuth authorization-code flow) for AUTH_MODE=google.

   What:  the login / callback / logout routes plus the `authenticate` middleware. No extra dependencies:
     - sessions are server-side rows in the SQLite `sessions` table: the HttpOnly cookie holds an opaque
       random token and only its sha256 is stored, so logout really revokes the session;
     - the anti-CSRF `state` lives in a short-lived signed cookie (utils/cookies.js);
     - the code is exchanged at Google's token endpoint and the id_token is checked with Google's tokeninfo
       endpoint; audience, issuer, expiry and email_verified are checked here as well;
     - users.external_id = Google `sub` (repo.upsertExternalUser).
   Endpoints (mounted under /api/v1): GET /auth/google/login, GET /auth/google/callback, POST /auth/logout.
   How it fits: app.js calls createGoogleAuth() when AUTH_MODE=google; routes/index.js mounts its routes
          before the authentication step and uses `authenticate` for everything after it.
   Read next: db/users-repo.js (users and sessions), routes/auth-status.js */
import crypto from "node:crypto";
import { Router } from "express";
import { HttpError } from "../utils/http-errors.js";
import { readCookies, createSigner } from "../utils/cookies.js";

const SESSION = "aq_session";
const STATE = "aq_oauth_state";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

/** Validates the Google settings at start-up so a misconfigured server fails fast instead of on the first login. */
function assertGoogleConfig(g) {
  const missing = ["clientId", "clientSecret", "redirectUri", "sessionSecret"].filter((k) => !g[k]);
  if (missing.length)
    throw new Error(
      `AUTH_MODE=google needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and SESSION_SECRET (missing: ${missing.join(", ")}).`
    );
  if (g.sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters.");
}

/**
 * Builds Google sign-in.
 *
 * @param {object} g  config.google: clientId, clientSecret, redirectUri, sessionSecret, sessionMaxAgeMs,
 *                    afterLogin and the three Google endpoint URLs
 * @param {object} deps
 * @param {object} deps.repo  the repository (users and sessions)
 * @param {typeof fetch} [deps.fetchImpl]  used to call Google (tests pass a fake)
 * @param {() => number} [deps.clock]
 * @returns {{ routes: import("express").Router, authenticate: Function, currentUser: (req) => number | null }}
 * @throws {Error} when a setting is missing or SESSION_SECRET is shorter than 32 characters
 */
export function createGoogleAuth(g, { repo, fetchImpl = fetch, clock = Date.now }) {
  assertGoogleConfig(g);
  const s = createSigner(g.sessionSecret);
  // Cookies are Secure whenever the public address is https; SameSite=lax still lets Google's redirect carry them.
  const secure = g.redirectUri.startsWith("https:");
  const cookie = (res, name, value, maxAgeMs) =>
    res.cookie(name, value, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: maxAgeMs });
  const clear = (res, name) => res.clearCookie(name, { httpOnly: true, sameSite: "lax", secure, path: "/" });

  const routes = Router();

  /** GET /auth/google/login?next=/path - redirects to Google; `next` is where to land after sign-in. */
  routes.get("/auth/google/login", (req, res) => {
    const state = crypto.randomBytes(16).toString("hex");
    const next = safeNext(req.query.next);
    cookie(res, STATE, s.sign({ state, exp: clock() + 10 * 60_000, ...(next ? { next } : {}) }), 10 * 60_000);
    const u = new URL(g.authUrl);
    u.search = new URLSearchParams({
      client_id: g.clientId,
      redirect_uri: g.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account"
    }).toString();
    res.redirect(302, u.toString());
  });

  /**
   * GET /auth/google/callback?code&state - Google sends the browser back here.
   * Checks state, exchanges the code, verifies the id_token, creates the session cookie and redirects.
   * Errors: 400 bad state, 401 Google refused or the token failed a check, 502 Google unreachable.
   */
  routes.get("/auth/google/callback", async (req, res, next) => {
    try {
      const { code, state } = req.query;
      const saved = s.verify(readCookies(req)[STATE], clock());
      clear(res, STATE);
      if (typeof code !== "string" || typeof state !== "string" || !saved || saved.state !== state)
        throw new HttpError(400, "Invalid OAuth state.");

      const tr = await fetchImpl(g.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: g.clientId,
          client_secret: g.clientSecret,
          redirect_uri: g.redirectUri,
          grant_type: "authorization_code"
        })
      });
      const tok = tr.ok ? await tr.json() : null;
      if (!tok || typeof tok.id_token !== "string") throw new HttpError(401, "Google sign-in failed.");

      const ir = await fetchImpl(`${g.tokeninfoUrl}?id_token=${encodeURIComponent(tok.id_token)}`);
      const info = ir.ok ? await ir.json() : null;
      const ok =
        info &&
        info.aud === g.clientId &&
        ISSUERS.has(info.iss) &&
        Number(info.exp) * 1000 > clock() &&
        typeof info.sub === "string" &&
        info.sub &&
        (info.email_verified === true || info.email_verified === "true");
      if (!ok) throw new HttpError(401, "Google sign-in failed.");

      const name = String(info.name || info.email || "user").slice(0, 200);
      const uid = repo.upsertExternalUser(info.sub, name, info.email || null, safePicture(info.picture));
      cookie(res, SESSION, repo.createSession(uid, clock(), g.sessionMaxAgeMs), g.sessionMaxAgeMs);
      res.redirect(302, safeNext(saved.next) || g.afterLogin);
    } catch (e) {
      next(e instanceof HttpError ? e : new HttpError(502, "Google sign-in failed."));
    }
  });

  /** POST /auth/logout - deletes the session row and the cookie. Always {ok: true}. */
  routes.post("/auth/logout", (req, res) => {
    repo.deleteSession(readCookies(req)[SESSION]);
    clear(res, SESSION);
    res.json({ ok: true });
  });

  /** The signed-in user id for this request, or null (used by /auth/status, which works without sign-in). */
  const currentUser = (req) => repo.sessionUser(readCookies(req)[SESSION], clock());

  /** Middleware: sets req.user = {id, name} for a live session, otherwise a 401 with code "auth_required". */
  function authenticate(req, _res, next) {
    const uid = currentUser(req);
    const u = uid && repo.getUser(uid);
    if (!u) return next(new HttpError(401, "Sign in required.", { code: "auth_required" }));
    req.user = { id: u.id, name: u.name };
    next();
  }

  return { routes, authenticate, currentUser };
}

/**
 * Accepts `?next=` only as a same-origin relative path, so the login flow cannot be used as an open redirect
 * ("/x" is fine; "//host", "/\\host", a scheme, whitespace or control characters are not).
 *
 * @param {unknown} v
 * @returns {string | null} the path, or null when it is not safe
 */
export function safeNext(v) {
  if (typeof v !== "string" || v.length > 512 || !v.startsWith("/") || v.startsWith("//")) return null;
  // eslint-disable-next-line no-control-regex -- matching control characters is the point of this check
  if (/[\\\s\x00-\x1f\x7f]/.test(v)) return null;
  return v;
}

/** Only an https URL is stored as the profile photo (it is shown in an <img>; CSP allows Google's image host). */
function safePicture(v) {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

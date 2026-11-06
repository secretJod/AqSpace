/* Google OAuth (authorization-code flow) for AUTH_MODE=google. No extra dependencies:
   - sessions are stateless HttpOnly cookies signed with HMAC-SHA256 (node:crypto) over { uid, exp },
   - the anti-CSRF `state` lives in a short-lived signed cookie,
   - the code is exchanged at Google's token endpoint and the id_token is verified via Google's tokeninfo endpoint
     (audience, issuer, expiry and email_verified are checked here as well),
   - users.external_id = Google `sub` (repo.upsertExternalUser).
   Endpoints (mounted under /api/v1): GET /auth/google/login, GET /auth/google/callback, POST /auth/logout. */
import crypto from "node:crypto";
import { Router } from "express";
import { HttpError } from "../http.js";

const SESSION = "aq_session";
const STATE = "aq_oauth_state";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

const b64u = (s) => Buffer.from(s).toString("base64url");

export function signer(secret) {
  const mac = (data) => crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return {
    sign(obj) { const p = b64u(JSON.stringify(obj)); return `${p}.${mac(p)}`; },
    verify(token, now) {
      if (typeof token !== "string") return null;
      const [p, sig] = token.split(".");
      if (!p || !sig) return null;
      const a = Buffer.from(sig), b = Buffer.from(mac(p));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      try { const o = JSON.parse(Buffer.from(p, "base64url").toString("utf8")); return o && o.exp > now ? o : null; }
      catch { return null; }
    }
  };
}

function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* bad cookie */ } }
  }
  return out;
}

/** Validates the google config at startup so a misconfigured server fails fast. */
export function assertGoogleConfig(g) {
  const missing = ["clientId", "clientSecret", "redirectUri", "sessionSecret"].filter((k) => !g[k]);
  if (missing.length) throw new Error(`AUTH_MODE=google needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and SESSION_SECRET (missing: ${missing.join(", ")}).`);
  if (g.sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters.");
}

/** Returns { routes, authenticate } for createApp. deps: { repo, fetchImpl, clock } */
export function createGoogleAuth(g, { repo, fetchImpl = fetch, clock = Date.now }) {
  assertGoogleConfig(g);
  const s = signer(g.sessionSecret);
  const secure = g.redirectUri.startsWith("https:");
  const cookie = (res, name, value, maxAgeMs) => res.cookie(name, value, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: maxAgeMs });
  const clear = (res, name) => res.clearCookie(name, { httpOnly: true, sameSite: "lax", secure, path: "/" });

  const routes = Router();
  routes.get("/auth/google/login", (_req, res) => {
    const state = crypto.randomBytes(16).toString("hex");
    cookie(res, STATE, s.sign({ state, exp: clock() + 10 * 60_000 }), 10 * 60_000);
    const u = new URL(g.authUrl);
    u.search = new URLSearchParams({
      client_id: g.clientId, redirect_uri: g.redirectUri, response_type: "code",
      scope: "openid email profile", state, prompt: "select_account"
    }).toString();
    res.redirect(302, u.toString());
  });

  routes.get("/auth/google/callback", async (req, res, next) => {
    try {
      const { code, state } = req.query;
      const saved = s.verify(readCookies(req)[STATE], clock());
      clear(res, STATE);
      if (typeof code !== "string" || typeof state !== "string" || !saved || saved.state !== state) throw new HttpError(400, "Invalid OAuth state.");

      const tr = await fetchImpl(g.tokenUrl, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: g.redirectUri, grant_type: "authorization_code" })
      });
      const tok = tr.ok ? await tr.json() : null;
      if (!tok || typeof tok.id_token !== "string") throw new HttpError(401, "Google sign-in failed.");

      const ir = await fetchImpl(`${g.tokeninfoUrl}?id_token=${encodeURIComponent(tok.id_token)}`);
      const info = ir.ok ? await ir.json() : null;
      const ok = info && info.aud === g.clientId && ISSUERS.has(info.iss) && Number(info.exp) * 1000 > clock()
        && typeof info.sub === "string" && info.sub && (info.email_verified === true || info.email_verified === "true");
      if (!ok) throw new HttpError(401, "Google sign-in failed.");

      const name = String(info.name || info.email || "user").slice(0, 200);
      const uid = repo.upsertExternalUser(info.sub, name, info.email || null);
      cookie(res, SESSION, s.sign({ uid, exp: clock() + g.sessionMaxAgeMs }), g.sessionMaxAgeMs);
      res.redirect(302, g.afterLogin);
    } catch (e) {
      next(e instanceof HttpError ? e : new HttpError(502, "Google sign-in failed."));
    }
  });

  routes.post("/auth/logout", (_req, res) => { clear(res, SESSION); res.json({ ok: true }); });

  function authenticate(req, _res, next) {
    const sess = s.verify(readCookies(req)[SESSION], clock());
    const u = sess && repo.getUser(sess.uid);
    if (!u) return next(new HttpError(401, "Sign in required."));
    req.user = { id: u.id, name: u.name };
    next();
  }

  return { routes, authenticate };
}

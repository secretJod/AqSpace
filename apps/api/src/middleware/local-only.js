/* local-only.js - keeps the API reachable only from this machine's own pages.

   What:  hostGuard refuses requests whose Host header is not localhost (DNS-rebinding guard).
          cors answers CORS only for local origins (plus TUNNEL_ORIGINS) and refuses state-changing requests from others.
          viaProxy() spots requests that came through the Cloudflare tunnel (or any reverse proxy);
          localOnly hides /dev from them (plain 404) and from any non-loopback Origin.
   How it fits: hostGuard + cors run in app.js right after the request logger; localOnly guards /dev;
          viaProxy is shared with middleware/rate-limit.js.
   Read next: middleware/rate-limit.js */
import { HttpError } from "../utils/http-errors.js";

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/** Extra trusted page origins (e.g. a Cloudflare tunnel), comma-separated; "*" matches one DNS label: https://*.trycloudflare.com */
export function originMatcher(list = "") {
  const res = list.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).map((o) =>
    new RegExp("^" + o.replace(/[.+?^${}()|[\]\\/]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+") + "$", "i"));
  return (origin) => LOCAL_ORIGIN_RE.test(origin) || res.some((re) => re.test(origin));
}
const isAllowedOrigin = originMatcher(process.env.TUNNEL_ORIGINS);

// ---------------------------------------------------------------------------
// 1. Host guard
// ---------------------------------------------------------------------------

/** Only answer to local host names (DNS-rebinding guard). */
export function hostGuard(req, res, next) {
  if (!LOCAL_HOST_RE.test(req.headers.host || "")) return next(new HttpError(403, "Forbidden host."));
  next();
}

// ---------------------------------------------------------------------------
// 2. CORS
// ---------------------------------------------------------------------------

const isReadOnly = (method) => method === "GET" || method === "HEAD";

/** CORS for local pages (and TUNNEL_ORIGINS) only. A non-local Origin on a state-changing request is refused outright. */
export function cors(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next();                        // same-origin or non-browser request

  const isLocal = isAllowedOrigin(origin);
  if (!isLocal && !isReadOnly(req.method)) return next(new HttpError(403, "Forbidden origin."));

  if (isLocal) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.append("Vary", "Origin");
    if (req.method === "OPTIONS") {                  // preflight
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
      return res.status(204).end();
    }
  } else if (req.method === "OPTIONS") {
    return res.status(204).end();                    // no CORS headers: the browser blocks the real request
  }
  next();
}

// ---------------------------------------------------------------------------
// 3. Tunnel / proxy detection and the /dev guard
// ---------------------------------------------------------------------------

/** Proxy headers that mark a request as having come through the Cloudflare tunnel (or any other reverse proxy). */
const PROXY_HEADERS = ["cdn-loop", "cf-connecting-ip", "cf-ray", "cf-visitor", "cf-ipcountry", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded",
  "x-forwarded-proto", "x-forwarded-port", "x-original-host", "true-client-ip", "via"];

/** True when the request carries any reverse-proxy header, i.e. it came through the Cloudflare tunnel. Shared by localOnly and clientKey. */
export function viaProxy(req) {
  const h = req.headers || {};
  return PROXY_HEADERS.some((k) => h[k] !== undefined);
}

/** /dev pages and APIs are for the developer's own machine: anything that arrived through the tunnel (or another proxy)
    gets a plain 404, so the public link never reveals that the dev tools exist. The tunnel rewrites Host to
    localhost:5180, so hostGuard alone cannot tell tunnel traffic from local traffic. */
export function localOnly(req, _res, next) {
  if (viaProxy(req)) return next(new HttpError(404, "Not found."));
  // Node lower-cases header names, so "CF-Ray" / "X-Forwarded-For" are caught above. Any Origin present
  // (including "null" or an empty string) must be a loopback page, never a TUNNEL_ORIGINS one.
  const origin = req.headers.origin;
  if (origin !== undefined && !LOCAL_ORIGIN_RE.test(origin)) return next(new HttpError(404, "Not found."));
  next();
}

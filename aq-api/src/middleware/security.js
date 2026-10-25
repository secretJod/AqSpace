/* Hand-written security middleware: headers, DNS-rebinding host guard, CORS (localhost only), tiny rate limiter. */
import { HttpError } from "../http.js";

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/** Extra trusted page origins (e.g. a Cloudflare tunnel), comma-separated; "*" matches one DNS label: https://*.trycloudflare.com */
export function originMatcher(list = "") {
  const res = list.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).map((o) =>
    new RegExp("^" + o.replace(/[.+?^${}()|[\]\\/]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+") + "$", "i"));
  return (origin) => LOCAL_ORIGIN_RE.test(origin) || res.some((re) => re.test(origin));
}
const isAllowedOrigin = originMatcher(process.env.TUNNEL_ORIGINS);

/** The UI is plain JS + Google Fonts + YouTube embeds/thumbnails/oEmbed; nothing else is allowed. */
export const CSP_APP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com https://s.ytimg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://i.ytimg.com https://img.youtube.com https://*.ytimg.com https://*.ggpht.com",
  "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com",
  "connect-src 'self' https://www.youtube.com",
  "media-src 'self' blob:",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'self'"
].join("; ");
export const CSP_API = "default-src 'none'; frame-ancestors 'self'";

export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  const api = req.path.startsWith("/api/");
  res.setHeader("Content-Security-Policy", api ? CSP_API : CSP_APP);
  if (api) res.setHeader("Cache-Control", "no-store");
  next();
}

/** Only answer to local host names (DNS-rebinding guard). */
export function hostGuard(req, res, next) {
  if (!LOCAL_HOST_RE.test(req.headers.host || "")) return next(new HttpError(403, "Forbidden host."));
  next();
}

/** CORS for local pages only. A non-local Origin on a state-changing request is refused outright. */
export function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    const ok = isAllowedOrigin(origin);
    if (!ok && req.method !== "GET" && req.method !== "HEAD") return next(new HttpError(403, "Forbidden origin."));
    if (ok) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.append("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Max-Age", "600");
        return res.status(204).end();
      }
    } else if (req.method === "OPTIONS") {
      return res.status(204).end();                     // no CORS headers: the browser blocks the real request
    }
  }
  next();
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^[0-9a-f:.]{2,45}$/i;
function looksLikeIp(v) { return IPV4_RE.test(v) || (v.includes(":") && IPV6_RE.test(v)); }

/**
 * Client key for rate limiting. With trustCf, a CF-Connecting-IP header is used only when the TCP peer is
 * loopback (i.e. the local cloudflared) and the header value is a plausible IP; otherwise the socket address.
 */
export function clientKey(req, trustCf = false) {
  const sock = req.socket?.remoteAddress || "?";
  if (trustCf && LOOPBACK.has(sock)) {
    const raw = req.headers?.["cf-connecting-ip"];
    const v = typeof raw === "string" ? raw.trim() : "";
    if (v && looksLikeIp(v)) return v.toLowerCase();
  }
  return sock;
}

/** Tiny in-memory fixed-window limiter per client IP. X-Forwarded-For is never trusted; CF-Connecting-IP only with trustCf (see clientKey). */
export function rateLimit({ max, windowMs, trustCf = false }, now = Date.now) {
  const hits = new Map();
  const timer = setInterval(() => { const t = now(); for (const [k, h] of hits) if (h.reset <= t) hits.delete(k); }, windowMs);
  timer.unref();
  return function limiter(req, res, next) {
    const key = clientKey(req, trustCf);
    const t = now();
    let h = hits.get(key);
    if (!h || h.reset <= t) { h = { n: 0, reset: t + windowMs }; hits.set(key, h); }
    h.n++;
    if (h.n > max) {
      const wait = Math.max(1, Math.ceil((h.reset - t) / 1000));
      res.setHeader("Retry-After", String(wait));
      return next(new HttpError(429, "Too many requests. Please slow down.", { retryAfter: wait }));
    }
    next();
  };
}

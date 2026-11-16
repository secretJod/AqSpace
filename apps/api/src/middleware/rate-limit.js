/* rate-limit.js - a tiny in-memory rate limiter.

   What:  rateLimit({ max, windowMs }) returns a middleware that allows `max` requests per
          client IP per window ("fixed window"), then answers 429 with Retry-After.
   How it fits: app.js builds two of them: "general" for the whole API and "heavy" for
          expensive calls (starting notes / smart runs, YouTube imports).
   Note:  X-Forwarded-For is never trusted. With TRUST_CF_HEADERS=1 each tunnel visitor gets their own
          bucket via CF-Connecting-IP, but only for tunnel requests from the loopback cloudflared (clientKey).
   Read next: middleware/request-logger.js */
import { HttpError } from "../utils/http-errors.js";
import { viaProxy } from "./local-only.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^[0-9a-f:.]{2,45}$/i;
function looksLikeIp(v) {
  return IPV4_RE.test(v) || (v.includes(":") && IPV6_RE.test(v));
}

/**
 * Client key for rate limiting. With trustCf, a CF-Connecting-IP header is used only when the TCP peer is
 * loopback (the local cloudflared), the request carries the tunnel proxy headers (viaProxy, same check as localOnly)
 * and the header value is a plausible IP; otherwise the socket address.
 */
export function clientKey(req, trustCf = false) {
  const sock = req.socket?.remoteAddress || "?";
  if (trustCf && LOOPBACK.has(sock) && viaProxy(req)) {
    const raw = req.headers?.["cf-connecting-ip"];
    const v = typeof raw === "string" ? raw.trim() : "";
    if (v && looksLikeIp(v)) return v.toLowerCase();
  }
  return sock;
}

/**
 * Builds a fixed-window rate limiter middleware. Over the limit it answers 429 with Retry-After.
 * The counters live in memory, so they reset on restart and are per process; enough for one local server.
 *
 * @param {object} options
 * @param {number} options.max       requests allowed per window and client
 * @param {number} options.windowMs  window length
 * @param {boolean} [options.trustCf]  see clientKey()
 * @param {() => number} [now]  clock, for tests
 * @returns {import("express").RequestHandler}
 */
export function rateLimit({ max, windowMs, trustCf = false }, now = Date.now) {
  const hitsByIp = new Map(); // ip -> { n, reset }

  // Forget expired windows now and then so the map does not grow forever.
  const cleanupTimer = setInterval(() => {
    const t = now();
    for (const [ip, hits] of hitsByIp) if (hits.reset <= t) hitsByIp.delete(ip);
  }, windowMs);
  cleanupTimer.unref(); // never keeps the process alive

  return function limiter(req, res, next) {
    const ip = clientKey(req, trustCf);
    const t = now();
    let hits = hitsByIp.get(ip);
    if (!hits || hits.reset <= t) {
      hits = { n: 0, reset: t + windowMs };
      hitsByIp.set(ip, hits);
    }
    hits.n++;
    if (hits.n > max) {
      const waitSec = Math.max(1, Math.ceil((hits.reset - t) / 1000));
      res.setHeader("Retry-After", String(waitSec));
      return next(new HttpError(429, "Too many requests. Please slow down.", { retryAfter: waitSec }));
    }
    next();
  };
}

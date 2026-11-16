/* security-headers.js - security response headers for every reply (written by hand, no helmet).

   What:  sets nosniff, frame options, referrer policy, CORP/COOP, permissions policy and a
          Content-Security-Policy (CSP). /api/* replies get a strict CSP and Cache-Control: no-store.
   How it fits: the first middleware in app.js. The /dev router replaces the CSP with its own (dev/dev-router.js).
   Read next: middleware/local-only.js */

// ---------------------------------------------------------------------------
// 1. Content-Security-Policy values
// ---------------------------------------------------------------------------

/** The UI is plain JS + Google Fonts + YouTube embeds/thumbnails/oEmbed + Google profile pictures; nothing else is allowed. */
export const CSP_APP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com https://s.ytimg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://i.ytimg.com https://img.youtube.com https://*.ytimg.com https://*.ggpht.com https://lh3.googleusercontent.com",
  "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com",
  "connect-src 'self' https://www.youtube.com",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join("; ");

/** JSON answers never need to load anything. */
export const CSP_API = "default-src 'none'; frame-ancestors 'self'";

// ---------------------------------------------------------------------------
// 2. The middleware
// ---------------------------------------------------------------------------

export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");

  const isApi = req.path.startsWith("/api/");
  res.setHeader("Content-Security-Policy", isApi ? CSP_API : CSP_APP);
  if (isApi) res.setHeader("Cache-Control", "no-store");
  next();
}

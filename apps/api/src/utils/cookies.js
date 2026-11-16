/* cookies.js - reading request cookies and signing small cookie values (no extra dependencies).

   What:  readCookies() parses the Cookie header; createSigner() makes tamper-proof, expiring
          tokens ("<base64url JSON>.<HMAC-SHA256>") for short-lived state such as the OAuth `state`.
   How it fits: used by middleware/google-auth.js.
   Read next: middleware/google-auth.js */
import crypto from "node:crypto";

const b64u = (s) => Buffer.from(s).toString("base64url");

/**
 * Parses the request's Cookie header. A value that cannot be URL-decoded is skipped.
 *
 * @param {import("express").Request} req
 * @returns {Record<string, string>} cookie name -> decoded value
 */
export function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* bad cookie */
      }
    }
  }
  return out;
}

/**
 * Signs and verifies small JSON payloads with HMAC-SHA256.
 * The signature is compared in constant time, so it cannot be guessed byte by byte.
 *
 * @param {string} secret  at least 32 characters (checked by the caller)
 * @returns {{ sign(obj: object): string, verify(token: unknown, now: number): object | null }}
 *          verify() returns the payload only when the signature matches and payload.exp > now.
 */
export function createSigner(secret) {
  const mac = (data) => crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return {
    sign(obj) {
      const p = b64u(JSON.stringify(obj));
      return `${p}.${mac(p)}`;
    },
    verify(token, now) {
      if (typeof token !== "string") return null;
      const [p, sig] = token.split(".");
      if (!p || !sig) return null;
      const a = Buffer.from(sig),
        b = Buffer.from(mac(p));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      try {
        const o = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
        return o && o.exp > now ? o : null;
      } catch {
        return null;
      }
    }
  };
}

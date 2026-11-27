/* key-box.js - encrypts users' AI provider keys at rest (AES-256-GCM, node:crypto).

   What:  createKeyBox({ secret, secretFile }) -> { encrypt(plain, aad), decrypt(sealed, aad) }.
          Each encryption uses a fresh random 12-byte IV; the 16-byte auth tag makes any
          tampering (or a wrong secret / wrong row) fail loudly instead of returning garbage.
          `aad` (e.g. "1:groq") binds a ciphertext to its user + provider, so rows cannot be swapped.
   Master secret: `secret` (AQ_KEY_SECRET, base64 of 32 bytes) or else the file `secretFile`
          (AQ_KEY_SECRET_FILE, default apps/api/data/.key-secret), created once with random bytes and
          owner-only permissions. Neither the secret nor any key is ever logged or put in an error message.
          The file is only read/created the first time a key is encrypted or decrypted.
   How it fits: used by services/ai-keys-service.js only.
   Read next: services/ai-keys-service.js */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALGO = "aes-256-gcm";

/** base64 text -> 32-byte Buffer, or throws (never includes the value in the message). */
function parseSecret(text, where) {
  const buf = Buffer.from(String(text || "").trim(), "base64");
  if (buf.length !== 32) throw new Error(`${where} must be base64 of exactly 32 bytes.`);
  return buf;
}

/** Reads the secret file, creating it (once, owner-only) when it does not exist yet. */
function loadOrCreateSecretFile(file) {
  try {
    return parseSecret(fs.readFileSync(file, "utf8"), "The key secret file");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    // "wx": never overwrite a secret another process just created (that would orphan its keys).
    fs.writeFileSync(file, crypto.randomBytes(32).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  return parseSecret(fs.readFileSync(file, "utf8"), "The key secret file");
}

/**
 * Builds the encrypt / decrypt pair for one master secret.
 *
 * @param {object} opts
 * @param {string} [opts.secret]      base64 of 32 bytes (AQ_KEY_SECRET); checked immediately
 * @param {string} [opts.secretFile]  file used when no secret is given; read or created on first use
 * @returns {{ encrypt: Function, decrypt: Function }}
 * @throws {Error} when the secret is malformed, or when neither a secret nor a file is configured
 */
export function createKeyBox({ secret = "", secretFile = "" } = {}) {
  // A configured secret is checked right away (bad config should stop the start-up, not a request).
  let master = secret ? parseSecret(secret, "AQ_KEY_SECRET") : null;
  if (!master && !secretFile) throw new Error("Set AQ_KEY_SECRET or a key secret file.");
  const getMaster = () => (master ||= loadOrCreateSecretFile(secretFile));

  /** plain text -> { ciphertext, iv, tag } (Buffers). */
  function encrypt(plain, aad = "") {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, getMaster(), iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  }

  /** { ciphertext, iv, tag } -> plain text. Throws when anything was changed or the secret is wrong. */
  function decrypt({ ciphertext, iv, tag }, aad = "") {
    const decipher = crypto.createDecipheriv(ALGO, getMaster(), Buffer.from(iv));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tag));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]).toString("utf8");
  }

  return { encrypt, decrypt };
}

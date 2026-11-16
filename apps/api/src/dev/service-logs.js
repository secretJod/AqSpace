/* service-logs.js - reads the end of the service console logs, with secrets masked.

   What:  start-all.ps1 writes each service's console output to ../.run/*.log.
          tailFile() reads the last lines of such a file; redactLine() hides API keys,
          tokens and passwords before anything leaves this server.
   How it fits: used by /dev/api/logs/:service in dev/dev-router.js.
   Read next: dev/dev-router.js */
import fs from "node:fs";

// ---------------------------------------------------------------------------
// 1. Which files belong to which service
// ---------------------------------------------------------------------------

export const LOG_FILES = {
  api: { out: "api.out.log", err: "api.err.log" },
  worker: { out: "ai.out.log", err: "ai.err.log" }
};

// ---------------------------------------------------------------------------
// 2. Masking secrets
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  [/gsk_[A-Za-z0-9]{8,}/g, "gsk_***"], // Groq
  [/AIza[0-9A-Za-z_-]{16,}/g, "AIza***"], // Google
  [/nvapi-[A-Za-z0-9_-]{8,}/g, "nvapi-***"], // NVIDIA
  [/hf_[A-Za-z0-9]{8,}/g, "hf_***"], // Hugging Face
  [/xai-[A-Za-z0-9_-]{8,}/g, "xai-***"], // xAI
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-***"], // OpenAI-style
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***"],
  [/\b(key|api_key|apikey|api-key|token|access_token|secret|password)(["']?\s*[=:]\s*["']?)[^\s&"',;]+/gi, "$1$2***"]
];

export function redactLine(s) {
  let out = String(s);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

// ---------------------------------------------------------------------------
// 3. Reading the end of a file
// ---------------------------------------------------------------------------

/** Last `n` lines (each redacted, max 4000 chars) from the last `maxBytes` of the file.
    -> {size, mtime, lines}, or null when the file does not exist. */
export async function tailFile(file, n, maxBytes = 512 * 1024) {
  let handle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch {
    return null;
  }
  try {
    const { size, mtime } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);

    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (length < size) lines.shift(); // we started mid-file: the first line is partial
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return { size, mtime: mtime.toISOString(), lines: lines.slice(-n).map((line) => redactLine(line.slice(0, 4000))) };
  } finally {
    await handle.close();
  }
}

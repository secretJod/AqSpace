/* validate.js - checks and cleans data sent by clients.

   What:  small functions that either return a clean value or throw a 400 (HttpError).
   How it fits: used by routes (ids in the URL) and by the repository (request bodies).
   Read next: db/playlists-repo.js (the main user of these helpers) */
import { bad } from "./http-errors.js";

// ---------------------------------------------------------------------------
// 1. Limits and patterns
// ---------------------------------------------------------------------------

/* Size limits for user text and batches. They keep rows small and match what the UI can show. */
export const LIMITS = { name: 60, description: 160, title: 150, channel: 80, batch: 500, maxSec: 360000 };

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/; // a YouTube video id
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/; // our playlist id ("my-playlist")
export const LIST_ID_RE = /^[A-Za-z0-9_-]{10,64}$/; // a YouTube playlist id (list=...)
export const JOB_ID_RE = /^[a-f0-9]{32}$/; // a job id from the Python worker

// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// ---------------------------------------------------------------------------
// 2. Basic helpers
// ---------------------------------------------------------------------------

/** True for a plain object (not null, not an array). */
export const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

/** Text without control characters, trimmed. Non-strings become "". */
export function text(x) {
  return typeof x === "string" ? x.replace(CONTROL_CHARS, " ").trim() : "";
}

// ---------------------------------------------------------------------------
// 3. Ids and names (throw a 400 when invalid)
// ---------------------------------------------------------------------------

/** A YouTube video id (11 characters), or a 400. */
export function videoId(x) {
  if (typeof x !== "string" || !VIDEO_ID_RE.test(x)) throw bad("Video id must be an 11-character YouTube id.");
  return x;
}

/** A playlist id ("my-playlist"), or a 400. */
export function slug(x) {
  if (typeof x !== "string" || !SLUG_RE.test(x)) throw bad("Invalid playlist id.");
  return x;
}

/** A playlist name: cleaned, not empty, at most LIMITS.name characters, or a 400. */
export function name(x) {
  const cleaned = text(x);
  if (!cleaned) throw bad("Give the playlist a name.");
  if (cleaned.length > LIMITS.name) throw bad(`Playlist name must be at most ${LIMITS.name} characters.`);
  return cleaned;
}

/** A playlist description: cleaned, at most LIMITS.description characters ("" when missing), or a 400. */
export function description(x) {
  if (x == null) return "";
  if (typeof x !== "string") throw bad("Description must be text.");
  const cleaned = text(x);
  if (cleaned.length > LIMITS.description) throw bad(`Description must be at most ${LIMITS.description} characters.`);
  return cleaned;
}

// ---------------------------------------------------------------------------
// 4. Durations and dates
// ---------------------------------------------------------------------------

/** Seconds from a number or "m:ss" / "h:mm:ss" / "" (0 = unknown). Invalid input -> 0. */
export function durationSec(x) {
  if (typeof x === "number") return Number.isFinite(x) && x > 0 && x < LIMITS.maxSec ? Math.floor(x) : 0;
  if (typeof x !== "string") return 0;
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})$/.exec(x.trim());
  if (!match) return 0;
  const hours = Number(match[1] || 0),
    minutes = Number(match[2]),
    seconds = Number(match[3]);
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 && total < LIMITS.maxSec ? total : 0;
}

/** "m:ss" / "h:mm:ss" ("" for 0) - the format the UI stores. */
export function clock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  if (!sec) return "";
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  const pad = (n) => (n < 10 ? "0" : "") + n;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** A valid date string becomes an ISO string; anything else returns `fallback`. */
export function isoOr(x, fallback) {
  const looksLikeDate = typeof x === "string" && x.length <= 40 && !Number.isNaN(Date.parse(x));
  return looksLikeDate ? new Date(x).toISOString() : fallback;
}

// ---------------------------------------------------------------------------
// 5. Bigger objects sent by the UI
// ---------------------------------------------------------------------------

/** A video as sent by a client. Text is trimmed/truncated (oEmbed titles can be long). Throws on a bad id. */
export function videoInput(v) {
  if (!isObj(v)) throw bad("Each video must be an object.");
  const id = videoId(v.id);
  return {
    id,
    title: text(v.title).slice(0, LIMITS.title) || `YouTube video ${id}`,
    channel: text(v.channel).slice(0, LIMITS.channel),
    durationSec: durationSec(v.durationSec != null ? v.durationSec : v.duration),
    added: isoOr(v.added, null)
  };
}

/** Where an imported playlist came from: only YouTube playlists are allowed. null = no source. */
export function source(s) {
  if (s == null) return null;
  const valid = isObj(s) && s.type === "youtube" && typeof s.listId === "string" && LIST_ID_RE.test(s.listId);
  if (!valid) throw bad("Invalid playlist source.");
  return { listId: s.listId, importedAt: isoOr(s.importedAt, null) };
}

/** Finite number >= 0 and <= max, else a 400. */
export function nonNeg(x, label, max = 1e7) {
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > max)
    throw bad(`${label} must be a number between 0 and ${max}.`);
  return x;
}

/* mask-path.js - removes ids from URL paths before the dev tracker stores them.

   What:  "/api/v1/playlists/my-list/smart?x=1" -> "/api/v1/playlists/:id/smart".
   How it fits: used by dev/tracker.js for every recorded request.
   Read next: dev/ring-buffer.js */

// After these words, the next path part is an id ...
const ID_PARENTS = new Set(["playlists", "notes", "progress", "jobs", "smart", "videos"]);
// ... unless it is one of these fixed words.
const FIXED_WORDS = new Set(["order", "html", "pdf", "smart", "videos"]);

/** Path without query string, ids masked, capped at 300 characters. */
export function maskPath(p) {
  const parts = String(p || "/")
    .split(/[?#]/)[0]
    .slice(0, 300)
    .split("/");
  const isApi = parts[1] === "api";
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (/^[a-f0-9]{16,}$/i.test(part))
      parts[i] = ":id"; // long hex = a job id, anywhere
    else if (isApi && part && ID_PARENTS.has(parts[i - 1]) && !FIXED_WORDS.has(part)) parts[i] = ":id";
  }
  return parts.join("/");
}

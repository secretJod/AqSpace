/* history-tools.js - filtering, CSV export and statistics for saved tracker entries.

   What:  pure functions (no I/O), easy to test:
            filterEntries() - search box / layer / status filters of the History page
            toCsv()         - spreadsheet-safe CSV
            computeStats()  - counts, error rates and p50/p95/max latency per path and per hour
   How it fits: used by /dev/api/history, /export and /stats in dev/dev-router.js.
   Read next: dev/service-logs.js */

const REQUEST_COLUMNS = ["seq", "ts", "layer", "method", "path", "status", "ms"];
const EVENT_COLUMNS = ["seq", "ts", "kind", "jobId", "videoId", "playlistId", "from", "to", "stage", "pct"];

/** Query values are untrusted: strings only, at most 100 characters. */
const cleanQueryValue = (value) => (typeof value === "string" ? value.slice(0, 100) : "");

// ---------------------------------------------------------------------------
// 1. Filtering
// ---------------------------------------------------------------------------

/** requests: layer = layer, status = first digit ("2","4","5") or "0" (network error).
    events:   layer = kind (notes/smart), status = the new state. q = free text search. */
export function filterEntries(type, items, { q = "", layer = "", status = "" } = {}) {
  const search = cleanQueryValue(q).trim().toLowerCase(),
    wantedLayer = cleanQueryValue(layer),
    wantedStatus = cleanQueryValue(status);
  return items.filter((e) => {
    if (type === "requests") {
      if (wantedLayer && e.layer !== wantedLayer) return false;
      if (wantedStatus && !statusMatches(e.status, wantedStatus)) return false;
      return !search || `${e.method} ${e.path} ${e.status}`.toLowerCase().includes(search);
    }
    if (wantedLayer && e.kind !== wantedLayer) return false;
    if (wantedStatus && e.to !== wantedStatus) return false;
    return (
      !search ||
      [e.kind, e.jobId, e.videoId, e.playlistId, e.from, e.to, e.stage].join(" ").toLowerCase().includes(search)
    );
  });
}

function statusMatches(status, wanted) {
  if (wanted === "0") return status === 0;
  return String(status)[0] === wanted && status !== 0;
}

// ---------------------------------------------------------------------------
// 2. CSV
// ---------------------------------------------------------------------------

/** RFC 4180 CSV; cells starting with = + - @ get a leading ' so spreadsheets do not run them as formulas. */
export function toCsv(type, items) {
  const columns = type === "requests" ? REQUEST_COLUMNS : EVENT_COLUMNS;
  const cell = (value) => {
    let s = value == null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.join(",");
  const rows = items.map((e) => columns.map((c) => cell(e[c])).join(","));
  return [header, ...rows].join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// 3. Statistics
// ---------------------------------------------------------------------------

/** Nearest-rank percentile of a sorted array. */
export function percentile(sorted, p) {
  return sorted.length ? sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] : null;
}

/** Network errors, 5xx and 4xx count as errors - except a UI 404 (browsers ask for favicon etc.). */
const isError = (e) =>
  e.status === 0 || e.status >= 500 || (e.status >= 400 && !(e.status === 404 && e.layer === "ui"));

/** Sorts `ms` in place and returns {p50, p95, max}. */
function latencySummary(ms) {
  ms.sort((a, b) => a - b);
  return { p50: percentile(ms, 50), p95: percentile(ms, 95), max: ms.length ? ms[ms.length - 1] : null };
}

const rate = (part, total) => (total ? +(part / total).toFixed(4) : 0);

export function computeStats(items) {
  const byPath = new Map();
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, errors: 0 }));
  const allMs = [];
  let errors = 0;

  for (const e of items) {
    const key = `${e.layer} ${e.method} ${e.path}`;
    let group = byPath.get(key);
    if (!group)
      byPath.set(key, (group = { layer: e.layer, method: e.method, path: e.path, count: 0, errors: 0, ms: [] }));
    group.count++;
    group.ms.push(e.ms);
    allMs.push(e.ms);

    const hour = new Date(e.ts).getUTCHours();
    const validHour = hour >= 0 && hour < 24; // NaN for a broken timestamp
    if (validHour) hours[hour].count++;
    if (isError(e)) {
      group.errors++;
      errors++;
      if (validHour) hours[hour].errors++;
    }
  }

  const paths = [...byPath.values()]
    .map(({ ms, ...group }) => ({ ...group, errorRate: rate(group.errors, group.count), ...latencySummary(ms) }))
    .sort((a, b) => b.count - a.count);

  return { total: items.length, errors, errorRate: rate(errors, items.length), ...latencySummary(allMs), paths, hours };
}

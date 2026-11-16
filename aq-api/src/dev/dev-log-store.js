/* dev-log-store.js - saves dev tracker entries to daily JSONL files (data/devlogs).

   What:  append() collects lines in memory and writes them in batches (every `flushMs`),
          so a request never waits for the disk. Files: requests-YYYY-MM-DD.jsonl and
          events-YYYY-MM-DD.jsonl (UTC day of the entry). Files older than keepDays are deleted.
   How it fits: created by dev/tracker.js when config.devLogDir is set; read by the
          /dev/api/history, /export and /stats endpoints in dev/dev-router.js.
   Read next: dev/tracker.js */
import fs from "node:fs";
import path from "node:path";

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^(requests|events)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

// ---------------------------------------------------------------------------
// 1. Flush everything when the process exits
// ---------------------------------------------------------------------------

const OPEN_STORES = new Set();
process.once("exit", () => { for (const store of OPEN_STORES) store.flushSync(); });

// ---------------------------------------------------------------------------
// 2. The store
// ---------------------------------------------------------------------------

/** Appends entries to <dir>/<type>-YYYY-MM-DD.jsonl (UTC day of entry ts). Writes are batched every `flushMs`. */
export function createDevLog({ dir, keepDays = 14, flushMs = 1000, now = Date.now } = {}) {
  fs.mkdirSync(dir, { recursive: true });

  let pending = new Map();                 // file path -> lines waiting to be written
  let timer = null;
  let writeChain = Promise.resolve();      // async writes run one after another, in order
  const fileFor = (type, day) => path.join(dir, `${type}-${day}.jsonl`);

  const store = {
    dir,

    append(type, entry) {
      const file = fileFor(type, String(entry.ts).slice(0, 10));
      if (!pending.has(file)) pending.set(file, []);
      pending.get(file).push(JSON.stringify(entry) + "\n");
      if (!timer) {
        timer = setTimeout(() => { timer = null; store.flush(); }, flushMs);
        timer.unref?.();
      }
    },

    /** Writes the pending lines (async). Returns a promise that resolves when they are on disk. */
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      const batch = pending;
      pending = new Map();
      writeChain = writeChain.then(async () => {
        for (const [file, lines] of batch) {
          try { await fs.promises.appendFile(file, lines.join("")); } catch { /* disk issue: drop, never break requests */ }
        }
      });
      return writeChain;
    },

    /** Same as flush(), but blocking - used on process exit. */
    flushSync() {
      for (const [file, lines] of pending) {
        try { fs.appendFileSync(file, lines.join("")); } catch { /* ignore */ }
      }
      pending = new Map();
    },

    /** Deletes files older than keepDays (by the date in the file name). Returns deleted names. */
    prune() {
      const cutoffDay = new Date(now() - keepDays * 86400000).toISOString().slice(0, 10);
      const deleted = [];
      for (const name of fs.readdirSync(dir)) {
        const match = FILE_RE.exec(name);
        if (match && match[2] < cutoffDay) {
          try { fs.unlinkSync(path.join(dir, name)); deleted.push(name); } catch { /* ignore */ }
        }
      }
      return deleted;
    },

    /** One summary per day, newest first: {date, requests, events, bytes} (line counts). */
    async days() {
      await store.flush();
      const byDay = new Map();
      for (const name of fs.readdirSync(dir).sort().reverse()) {
        const match = FILE_RE.exec(name);
        if (!match) continue;
        const [, type, day] = match;
        const summary = byDay.get(day) || { date: day, requests: 0, events: 0, bytes: 0 };
        const buffer = await fs.promises.readFile(path.join(dir, name));
        summary[type] = countNewlines(buffer);
        summary.bytes += buffer.length;
        byDay.set(day, summary);
      }
      return [...byDay.values()];
    },

    /** All entries of one type and day ([] when there is no file). */
    async read(type, day) {
      await store.flush();
      let content;
      try { content = await fs.promises.readFile(fileFor(type, day), "utf8"); } catch { return []; }
      const entries = [];
      for (const line of content.split("\n")) {
        if (!line) continue;
        try { entries.push(JSON.parse(line)); } catch { /* torn line */ }
      }
      return entries;
    },

    close() {
      store.flushSync();
      OPEN_STORES.delete(store);
    }
  };

  OPEN_STORES.add(store);
  store.prune();
  return store;
}

function countNewlines(buffer) {
  let count = 0;
  for (const byte of buffer) if (byte === 10) count++;
  return count;
}

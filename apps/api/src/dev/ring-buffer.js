/* ring-buffer.js - a fixed-size in-memory list of recent entries.

   What:  push() adds an entry with a sequence number and timestamp; the oldest entry
          is dropped when the list is full. since(seq) returns what came after `seq`
          (the dev pages poll with the last seq they saw).
   How it fits: dev/tracker.js keeps one ring for requests and one for job events.
   Read next: dev/dev-log-store.js */

/** onPush(entry) is called for every new entry (used to also write it to disk). */
export function createRingBuffer(max, onPush) {
  const items = [];
  let seq = 0;

  return {
    push(fields) {
      const entry = { seq: ++seq, ts: new Date().toISOString(), ...fields };
      items.push(entry);
      if (items.length > max) items.shift();
      if (onPush) onPush(entry);
      return entry;
    },
    /** Entries with seq > afterSeq that pass `filter`, at most `limit`. */
    since(afterSeq, limit, filter = () => true) {
      const out = [];
      for (const entry of items) {
        if (entry.seq > afterSeq && filter(entry)) {
          out.push(entry);
          if (out.length >= limit) break;
        }
      }
      return out;
    },
    get last() {
      return seq;
    },
    get size() {
      return items.length;
    },
    all: () => items
  };
}

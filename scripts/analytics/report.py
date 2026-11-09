#!/usr/bin/env python3
"""AQspace analytics, step 1 (#138): a local report from data aq-api already keeps.

Reads aq-api's dev tracker JSONL (aq-api/data/devlogs/events-*.jsonl) and the SQLite
notes_jobs table (aq-api/data/aq.db, opened read-only) and prints jobs by kind, success
rate, median duration and retries/fallback signals. Uses DuckDB if it is importable from
the repo venv; otherwise plain Python + sqlite3. Writes nothing, installs nothing.

Usage:
  python3 scripts/analytics/report.py [--devlogs DIR] [--db FILE] [--days N]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sqlite3
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DONE = {"ready", "done"}
FAILED = {"error", "failed", "expired"}


def ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def load_events(devlogs: str, days: int) -> list[dict]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    rows = []
    for f in sorted(glob.glob(os.path.join(devlogs, "events-*.jsonl"))):
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                    if ts(e["ts"]) >= cutoff:
                        rows.append(e)
                except (ValueError, KeyError):
                    continue  # skip torn/partial lines
    return rows


def job_runs(events: list[dict]) -> list[dict]:
    """Collapse state-change events into one row per (kind, jobId)."""
    by = defaultdict(list)
    for e in events:
        if e.get("jobId"):
            by[(e.get("kind", "?"), e["jobId"])].append(e)
    runs = []
    for (kind, jid), evs in by.items():
        evs.sort(key=lambda e: e["ts"])
        last = evs[-1].get("to")
        outcome = "done" if last in DONE else "failed" if last in FAILED else "open"
        runs.append({"kind": kind, "job": jid, "outcome": outcome,
                     "sec": (ts(evs[-1]["ts"]) - ts(evs[0]["ts"])).total_seconds(),
                     "subject": evs[0].get("videoId") or evs[0].get("playlistId")})
    return runs


def report_events(runs: list[dict]) -> None:
    print("== Pipeline runs from devlogs (by kind) ==")
    if not runs:
        print("  no events found (start aq-api with the dev tracker on, then run some notes jobs)")
        return
    print(f"  {'kind':<8}{'runs':>6}{'done':>6}{'failed':>8}{'open':>6}{'success%':>10}{'median s':>10}")
    for kind in sorted({r['kind'] for r in runs}):
        rs = [r for r in runs if r["kind"] == kind]
        c = Counter(r["outcome"] for r in rs)
        closed = c["done"] + c["failed"]
        rate = f"{100 * c['done'] / closed:.0f}" if closed else "-"
        durs = [r["sec"] for r in rs if r["outcome"] == "done"]
        med = f"{statistics.median(durs):.1f}" if durs else "-"
        print(f"  {kind:<8}{len(rs):>6}{c['done']:>6}{c['failed']:>8}{c['open']:>6}{rate:>10}{med:>10}")
    retried = Counter(r["subject"] for r in runs if r["kind"] == "notes")
    print(f"  videos needing >1 notes run (retry/fallback proxy): {sum(1 for n in retried.values() if n > 1)}")


def report_db(db: str) -> None:
    print("== notes_jobs table (SQLite, read-only) ==")
    if not os.path.exists(db):
        print(f"  {db} not found")
        return
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        rows = con.execute("SELECT status, created_at, updated_at, error FROM notes_jobs").fetchall()
    except sqlite3.Error as e:
        print(f"  cannot read notes_jobs: {e}")
        return
    finally:
        con.close()
    c = Counter(r[0] for r in rows)
    closed = c["done"] + c["error"] + c["expired"]
    print(f"  jobs: {len(rows)}  by status: {dict(c)}")
    if closed:
        print(f"  success rate: {100 * c['done'] / closed:.0f}%")
    durs = [(ts(u) - ts(cr)).total_seconds() for s, cr, u, _ in rows if s == "done"]
    if durs:
        print(f"  median created->updated span: {statistics.median(durs):.1f} s (upper bound; updated_at also moves on later polls, prefer the devlogs figure)")
    # error text is categorised only; it is never printed (may name a provider message, never a key)
    cats = Counter("quota" if "quota" in e.lower() or "rate limit" in e.lower() else "other"
                   for s, _, _, e in rows if s == "error")
    if cats:
        print(f"  error categories: {dict(cats)}  (quota = provider quota/rate-limit hit)")


def report_duckdb(devlogs: str) -> bool:
    try:
        import duckdb  # optional; only if present in the repo venv
    except ImportError:
        return False
    pattern = os.path.join(devlogs, "events-*.jsonl")
    if not glob.glob(pattern):
        return True
    print("== DuckDB: events per day ==")
    q = f"SELECT CAST(ts AS DATE) d, kind, count(*) n FROM read_json_auto('{pattern}') GROUP BY 1,2 ORDER BY 1,2"
    for d, k, n in duckdb.sql(q).fetchall():
        print(f"  {d} {k:<8}{n:>6}")
    return True


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--devlogs", default=os.environ.get("AQ_DEVLOG_DIR") or os.path.join(ROOT, "aq-api", "data", "devlogs"))
    ap.add_argument("--db", default=os.environ.get("DB_FILE") or os.path.join(ROOT, "aq-api", "data", "aq.db"))
    ap.add_argument("--days", type=int, default=30)
    a = ap.parse_args(argv)
    print(f"AQspace analytics report (last {a.days} days)\n  devlogs: {a.devlogs}\n  db: {a.db}\n")
    report_events(job_runs(load_events(a.devlogs, a.days)))
    print()
    report_db(a.db)
    print()
    if not report_duckdb(a.devlogs):
        print("(DuckDB not in this Python; plain-Python report shown. Optional: lecture-notes-ai/.venv/bin/pip install duckdb)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

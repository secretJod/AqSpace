"""Run the notes-provider evaluation end to end through the app's own pipeline (resumable).

From ``lecture-notes-ai/``::

  .venv/bin/python -m demo.notes_eval.run_eval --contestants gemini,groq,local --videos default
  .venv/bin/python -m demo.notes_eval.run_eval --contestants gemini,groq,local --videos default --dry-run
  .venv/bin/python -m demo.notes_eval.run_eval --contestants local:qwen3.5-9b,local:gpt-oss-20b@http://127.0.0.1:8082/v1
  .venv/bin/python -m demo.notes_eval.run_eval --judge groq          # a judge that is not a contestant
  .venv/bin/python -m demo.notes_eval.run_eval --judge-only

Contestants: a known id (gemini, groq, nvidia-super, nvidia-lightning, local) or a spec
``provider[:model][@url]`` (``@url`` only for local; otherwise LNAI_LOCAL_URL is used).

Every generation calls ``notes_engine.llm.generate_notes`` exactly as the app does (same provider
profiles, same prompts, same validation) with the response cache, checkpoints and provider fallback
switched OFF, so every run is a fresh answer from the named contestant.

``--dry-run`` swaps only the network for fakes (``fakes.py``): synthetic transcripts, canned model and
judge answers, output under ``out/dry-run/``. No keys are read, no API is called, nothing is downloaded.

Outputs: out/runs, out/judgements, out/evaluation.json, the blind human sheet
``docs/qa/r5-eval-blind.md`` and its key ``out/blind-key.json`` (keep the key closed until you scored).
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import time

try:  # python -m demo.notes_eval.run_eval (package) or python demo/notes_eval/run_eval.py
    from . import common as C
except ImportError:  # pragma: no cover
    import common as C  # type: ignore[no-redef]


def log(msg: str) -> None:
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def fetch_transcripts(videos: list[str], dry: bool) -> dict[str, dict]:
    out = {}
    for vid in videos:
        p = C.TRANSCRIPTS / f"{vid}.json"
        t = C.read_json(p)
        if isinstance(t, dict) and t.get("segments"):
            out[vid] = t
            continue
        if dry:
            from . import fakes
            t = fakes.transcript(vid, C.VIDEOS.get(vid, vid))
        else:
            from notes_engine import ingest
            log(f"fetching transcript {vid}")
            os.environ["LNA_CACHE_DIR"] = str(C.ROOT / "backend" / ".cache")   # reuse the app's transcript cache
            try:
                t = ingest.get_transcript(f"https://www.youtube.com/watch?v={vid}")
            finally:
                os.environ.pop("LNA_CACHE_DIR", None)  # generation must NOT hit the engine's digest cache
        C.write_json(p, t)
        out[vid] = t
    return out


def generate(cid: str, vid: str, n: int, transcript: dict) -> dict:
    from notes_engine import llm
    from notes_engine.notes_schema import validate_notes
    c = C.CONTESTANTS[cid]
    C.install_meter()
    C.METER.reset()
    C.METER.active = True
    rec = {"contestant": cid, "provider": c["provider"], "model": C.model_of(cid), "video": vid, "run": n,
           "local_url": c.get("url") if c["provider"] == "local" else None,
           "started": dt.datetime.now().isoformat(timespec="seconds")}
    t0 = time.perf_counter()
    try:
        with C.clean_run_env(c.get("url")):
            if c["provider"] == "local":
                k = None   # the engine reads LNAI_LOCAL_KEY itself, like the app
            else:
                k = C.key(c["env"])
                if not k:
                    raise llm.LLMError(f"No API key ({c['env']}) found.")
            notes = llm.generate_notes(transcript, provider=c["provider"], api_key=k, model=c["model"],
                                       checkpoint_dir=None)
        used = str((notes.get("meta") or {}).get("model") or "")
        if used and not used.startswith(c["provider"] + "/"):
            raise llm.LLMError(f"answered by another provider ({used}); fallback must be off for the eval")
        rec["status"] = "success"
        rec["notes"] = notes
        try:
            validate_notes(notes, transcript)
            rec["schema_valid"] = True
        except Exception:  # noqa: BLE001
            rec["schema_valid"] = False
    except Exception as e:  # noqa: BLE001
        msg = C.scrub(str(e) or type(e).__name__)
        rec.update(status="error", error=msg, error_type=C.classify_error(msg), schema_valid=False)
    finally:
        C.METER.active = False
    m = C.METER
    rec["latency_sec"] = round(time.perf_counter() - t0, 2)
    rec["timing"] = {
        "http_requests": m.requests, "http_statuses": m.statuses, "http_sec": round(m.http_sec, 2),
        "sleep_sec": round(m.sleep_sec, 2), "ok_responses": m.ok_responses,
        "usage_reported_responses": m.usage_reported,
        "prompt_tokens": m.prompt_tokens if m.usage_reported else None,
        "output_tokens": m.output_tokens if m.usage_reported else None,
    }
    return rec


def _csv(values: list[str]) -> list[str]:
    return [x.strip() for v in values for x in v.split(",") if x.strip()]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="python -m demo.notes_eval.run_eval")
    ap.add_argument("--videos", nargs="*", default=["default"],
                    help="video ids, comma or space separated; 'default' = the 4 fixed videos")
    ap.add_argument("--contestants", nargs="*", default=["gemini,groq,local"],
                    help="ids or provider[:model][@url] specs, e.g. gemini,groq,local:qwen3.5-9b")
    ap.add_argument("--judge", default="gemini",
                    help="judge provider[:model][@url] (default gemini; it is biased toward gemini notes)")
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--judge-only", action="store_true")
    ap.add_argument("--no-judge", action="store_true")
    ap.add_argument("--retry-failed", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="fakes only: no network, no keys, out/dry-run/")
    ap.add_argument("--out", default=None, help="output dir (default out/, or out/dry-run with --dry-run)")
    ap.add_argument("--blind-sheet", default=None, help=f"blind sheet path (default {C.BLIND_SHEET})")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> dict:
    a = parse_args(argv)
    videos = _csv(a.videos)
    if videos == ["default"] or not videos:
        videos = list(C.VIDEOS)
    for v in videos:
        if v not in C.VIDEOS:
            C.VIDEOS[v] = v   # ad-hoc video id
    contestants = [C.register_contestant(s) for s in _csv(a.contestants)]
    C.SELECTED[:] = contestants
    C.set_judge(a.judge)

    if a.dry_run:
        from . import fakes
        fakes.install()
        C.set_out(a.out or (C.HERE / "out" / "dry-run"))
        log("DRY RUN: fakes only, no network, output in " + str(C.OUT))
    elif a.out:
        C.set_out(a.out)
    sheet = a.blind_sheet or (C.OUT / "r5-eval-blind.md" if a.dry_run else C.BLIND_SHEET)

    biased = C.judge_is_contestant(contestants)
    names = ", ".join(f"{c}={C.CONTESTANTS[c]['provider']}/{C.model_of(c)}" for c in contestants)
    log(f"contestants: {names}")
    log(f"judge: {C.JUDGE_PROVIDER}/{C.judge_model()}")
    if biased:
        log(f"WARNING judge bias: the judge's provider also made {', '.join(biased)}; treat those judge scores "
            "as optimistic and use the blind human sheet (or --judge <other>) to confirm.")

    ts = fetch_transcripts(videos, a.dry_run)
    quota_dead: set[str] = set()   # contestants that hit a hard daily quota this session
    if not a.judge_only:
        for n in range(1, a.runs + 1):          # run 1 for everything first, so a quota hit only costs run 2
            for vid in videos:
                for cid in contestants:
                    p = C.run_path(cid, vid, n)
                    old = C.read_json(p)
                    if isinstance(old, dict) and (old.get("status") == "success" or not a.retry_failed):
                        continue
                    if vid not in ts:
                        continue
                    if cid in quota_dead:
                        rec = {"contestant": cid, "provider": C.CONTESTANTS[cid]["provider"], "model": C.model_of(cid),
                               "video": vid, "run": n, "status": "skipped", "error_type": "quota_daily",
                               "error": "Not attempted: this contestant hit a hard daily quota earlier in the session.",
                               "latency_sec": None, "schema_valid": False, "timing": {}}
                        C.write_json(p, rec)
                        continue
                    log(f"generate {cid} {vid} #{n} ...")
                    rec = generate(cid, vid, n, ts[vid])
                    C.write_json(p, rec)
                    log(f"  -> {rec['status']} {rec['latency_sec']}s {rec.get('error_type', '')} {rec.get('error', '')[:120]}")
                    if rec.get("error_type") == "quota_daily":
                        quota_dead.add(cid)
    from . import blind
    key = blind.write_sheet(videos, contestants, sheet, C.OUT / "blind-key.json")
    log(f"blind sheet: {sheet} ({len(key['videos'])} videos); key: {C.OUT / 'blind-key.json'} (do not open before scoring)")
    if a.no_judge:
        return {"contestants": contestants, "sheet": str(sheet)}
    from . import evaluate
    if a.dry_run:
        evaluate.JUDGE_PACE_SEC = 0.0
    evaluate.judge_all(ts, videos, contestants, a.runs, dry=False, log=log)
    ev = evaluate.aggregate()
    log(f"wrote {C.OUT / 'evaluation.json'}")
    if not a.dry_run:
        try:
            from . import build_data
            build_data.main()
        except Exception as e:  # noqa: BLE001  (the dev page is optional)
            log(f"dev page data not written: {e}")
    return {"contestants": contestants, "sheet": str(sheet), "evaluation": ev}


if __name__ == "__main__":
    main()

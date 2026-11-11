# ADR-0003: Local notes model: Qwen3-8B (GGUF) on llama.cpp with Metal, native on the Mac

- Status: Accepted (numbers marked *assumed* get replaced by web-dev-2's measurements on card #37)
- Date: 2026-11-01
- Decider: scaling-lead (card #29)

## Context

R5 needs notes from our own model with no rate limits, for videos **up to 24 hours long**, at Groq (`openai/gpt-oss-120b`) quality or better. The user picked `models/Qwen3-8B-Q4_K_M.gguf` (5.0 GB, gitignored). The machine is an Apple M2 with 16 GB of unified memory, which also runs Docker Desktop (aq-api, notes-ai) and Chromium. `notes_engine/llm.py` already has single-pass plus map-reduce (digest per chunk, compose per digest batch, final call), driven by per-provider profiles in `_BASE_PROFILES` / `_profile`.

Constraints: Docker on macOS runs in a Linux VM with **no GPU access**, so a containerised model would run on CPU at a fraction of the speed. Qwen3-8B has a 32K native context. One model server at a time; no other GPU jobs.

## Options

1. **GGUF + llama.cpp `llama-server`, native, Metal.** *(chosen)* Runs the file we already have with full Metal offload, serves an OpenAI-compatible `/v1/chat/completions`, and is a single binary in `.tools/llama.cpp` (repo-local). The same server runs on Colab/Linux CUDA later.
2. **Ollama.** Easy, but installs a global app and a model store under `~/.ollama` (breaks the storage rule) and is a layer over llama.cpp anyway.
3. **MLX (`mlx-lm`).** Slightly faster on Apple silicon, but needs different weights (re-download) and is Mac-only, so Colab would need a second stack.
4. **llama.cpp inside Docker.** CPU only on macOS, roughly 5-10x slower. Rejected.

## Decision

### Runtime
`llama-server` native on the host at `127.0.0.1:8081`, model alias `qwen3-8b`, provider `local` (no key) with `LNAI_LOCAL_URL` (default `http://127.0.0.1:8081/v1`; from Docker `http://host.docker.internal:8081/v1`).

```
.tools/llama.cpp/llama-server -m models/Qwen3-8B-Q4_K_M.gguf --alias qwen3-8b \
  --host 127.0.0.1 --port 8081 -ngl 99 -c 16384 -np 1 -fa on \
  -ctk q8_0 -ctv q8_0 -b 2048 -ub 512 -t 4 --jinja --no-webui
```

| Setting | Value | Why |
|---|---|---|
| ctx-size | **16384** (of 32K native) | The largest call is ~14k tokens (below). 16K halves KV memory and keeps prompt processing fast; 32K only buys bigger chunks, which hurt recall on an 8B model. |
| parallel | **1** | One slot gets the whole context and the whole GPU; the pipeline is sequential anyway. |
| batch / ubatch | 2048 / 512 | Good prompt-processing throughput on M2 Metal without large compute buffers. |
| flash attention | on | Required for the quantised KV cache; lowers memory. |
| KV cache | q8_0 | ~1.2 GB at 16K (f16 would be ~2.4 GB) with negligible quality loss. |
| threads | 4 | The M2's performance cores; the GPU does the math. |
| sampling | non-thinking: temp 0.7, top_p 0.8, top_k 20; thinking: temp 0.6, top_p 0.95 | Qwen3's recommended settings; never greedy (it loops). |

**Memory budget (16 GB):** model 5.0 + KV 1.2 + compute ~0.6 = **~7 GB** for llama-server (under Metal's ~10.7 GB working-set cap). Cap the Docker Desktop VM at **4 GB** (Settings > Resources); Chromium plus macOS take ~4-5 GB. Swap during a long run is the main slowdown risk, so close heavy apps for 24h jobs.

### `local` profile (chars, at ~3.3 chars/token as in `llm.py`)
| Key | Value | Token cost per call |
|---|---|---|
| single_chars | 12000 | 3.6k in + 1.5k prompt + 6k out ~ 11k (videos up to ~15 min) |
| chunk_chars | 24000 | 7.3k in + 1k prompt + 1.5k out ~ 10k |
| digest_cap / digest_out | 2500 chars / 1500 tokens | dense facts, timestamps, formulas |
| batch_chars | 20000 | 6k in + 2k prompt + 6k out ~ 14k (fits 16K) |
| out_single / out_batch / final_out | 6000 / 6000 / 4000 | about 6 sections per compose call |
| tpm | None | no rate limit |
| reasoning_reserve | 0 for map/compose, 1500 for the final call | |

**Thinking:** **off** (`/no_think`, `<think>` stripped) for **map and compose**: they are extraction and writing, and thinking would roughly triple generation time per call. **On** for the **final call** (subtitle, overview, glossary, recap over the whole outline) and an optional **verify pass** (section order and coverage against the digest list). Those are one or two calls per video, where reasoning improves coherence at little cost. Beating Groq comes from smaller chunks (more detail per minute of video) and no token-budget squeeze, not from model size.

### Capacity estimate
*Assumed* M2 speeds at 8-14k context: prompt processing **150 tok/s**, generation **12 tok/s**.

| Video | Transcript | Map | Reduce | Total |
|---|---|---|---|---|
| 1 h (~9-10k words, ~57k chars) | 3 chunks | 3 x ~3 min = 9 min | 1-2 compose x ~9 min + final ~6 min | **~25-35 min** |
| 24 h (~250k words, ~1.4M chars, ~420k tokens) | ~58 chunks | 58 x ~3 min = **~2.9 h** | merge + compose + final, **~2-2.5 h** | **~5-6 h**; worst case ~10 h if speeds halve (thermals, swap) |

Generation dominates: 1500 digest tokens take ~125 s, prompt processing ~55 s per chunk.

**Hierarchical reduce:** 58 digests x 2.5k chars = ~145k chars, too much for one compose and too many sections to read. Rule: if total digest text > 3 x batch_chars (~60k chars, about a 10 h video), add a **merge level** that turns each group of 8 consecutive digests into one 4k-char part digest (~8 calls, ~4 min each). Compose runs per part ("Hours 0-3", ~8 x 9 min) and the final call runs once over the part outlines. Depth: 1 reduce level up to ~10 h, 2 levels up to 24 h; the rule applies recursively, so longer input adds a level.

### Checkpoint / resume
Every finished call writes into `<job output dir>/checkpoints/<video_id>/`: `meta.json` (model, profile hash, chunk boundaries, transcript sha256), `map/0007.json`, `merge/01.json`, `compose/03.json`, `final.json`, each written to a temp file and renamed (atomic). On start the job loads checkpoints whose transcript and profile hashes match and skips that work, so a crash or reboot loses at most one call (~3-9 min). A changed model or profile invalidates them. The folder is deleted once notes are saved; it lives under the gitignored job output, so `scripts/nuke.sh` removes it.

~~**Fallback:** if `local` is unreachable, videos that fit Groq's short path (up to ~1 h) fall back to Groq; longer videos stay **queued** until local is back.~~ (superseded 2026-11-06, F8, see ADR-0005)

**Fallback (updated 2026-11-06, F8, PR #72):** with `LNA_PROVIDER_FALLBACK=1`, if `local` is unreachable, videos up to `LNAI_GROQ_FALLBACK_MAX_SEC` (default 1 h) fall back to Groq; longer videos fall back to NVIDIA Nemotron when `NVIDIA_API_KEY` is set, and otherwise stay **queued** until local is back. A fallback is one whole new run: never mix providers inside one video. The default provider is now Gemini (ADR-0005).

### Drive backup (card #38)
Use the **Drive API with the `drive.file` scope** on the existing Google OAuth client. The app only sees files it created (non-sensitive scope, no Google verification), uploads notes JSON + PDF to `AQspace Notes/<playlist>/` after each finished job, and works the same from Docker, the Mac or Colab. A Drive-for-desktop synced folder is rejected: it needs a global app install, depends on desktop sync being up, needs a bind mount outside the repo to reach Docker, and does not exist on Colab. Checkpoints stay local (too chatty); only finished notes go to Drive.

### Colab (card #39; covered by the https `local` provider, see ADR-0005)
Optional runner of the **same** `llama-server` (CUDA build, same GGUF or a larger Qwen3 on L4/A100) behind a tunnel, selected through `LNAI_LOCAL_URL`. Move there when any of these holds: measured 24h runs exceed ~10 h on the Mac; the user needs the Mac during long jobs; more than one long video a day is queued; or we want a bigger model (Qwen3-30B-A3B / 32B) for quality.

## Consequences

- Positive: no rate limits or API cost; 24h videos finish overnight; pipeline, prompts and schema are shared with all providers; the runner moves to Colab unchanged.
- Negative: the Mac is busy and warm for hours per 24h video; one job at a time; an 8B model can be weaker than a 120B one on reasoning-heavy lectures, so ai-dev-1 runs the Groq comparison on 3 sample transcripts before R5 is called done.

## Risks

| Risk | Mitigation |
|---|---|
| Real speeds below the assumptions (throttling, swap) | #37 measures pp/tg; profile values are tunable; resume makes slowness safe; Colab trigger above. |
| Memory pressure with Docker + Chromium | Docker VM at 4 GB, KV q8_0, ctx 16K, single slot. |
| Qwen3 loops or leaks `<think>` text | Recommended sampling, `presence_penalty` 1.0 if loops appear, strip `<think>`, schema validation + retry. |
| Repetition across parts of a 24h lecture | Merge level groups by time; final call sees every part outline. |
| llama.cpp flag/API drift | Pin the built version in `.tools/llama.cpp/VERSION`. |
| Lost work on crash | Per-call checkpoints keyed by video id + hashes. |

# ADR-0005: Notes provider strategy (Gemini default, fallback chain, local and Colab)

- Status: Accepted (to be confirmed or changed by the measured evaluation, card #75)
- Date: 2026-11-06
- Decider: scaling-lead (card #78, R7)
- Related: ADR-0003 (local Qwen3-8B), ADR-0004 (upstream convergence), PR #72 (https `local`, NVIDIA fallback), #74 (Gemini pacing), #75 (evaluation), #39 (Colab runner)

## Context

R7 made Gemini the default notes provider. We now have five ways to turn a transcript into notes: `gemini`, `groq`, `nvidia` (Nemotron on NIM), `local` (llama.cpp `llama-server` on the Mac, or any http/https server with an optional bearer key since PR #72) and the deprecated `colab` alias. Each has different limits, cost and privacy. Videos range from minutes to 24 h. We need one written rule for which provider runs, what happens when it fails, and when a user should choose local or Colab.

## Options

1. **Local first by default** (ADR-0003). Private and unlimited, but slow (~25-35 min per 1 h video, 5-6 h for 24 h) and it needs the Mac on with the model loaded. Bad first-run experience.
2. **Gemini default, overridable; local and Colab as opt-in; fallback chain for local.** Fast, large context, free tier; local stays for privacy and very long videos.
3. **Groq default.** Fast, but 8k tokens/min and 200k tokens/day on the free tier: one 24 h video (~420k tokens) exceeds a whole day's quota.

## Decision

Option 2.

### Default
- `PY_NOTES_PROVIDER=gemini` is the default. Any deployment or user can override it (`local`, `groq`, `nvidia`). The app never switches the user's chosen provider silently except through the fallback chain below.

### Fallback chain (only when `LNA_PROVIDER_FALLBACK=1`, for `local`/`colab`)
- `local` unreachable -> **Groq** for videos up to `LNAI_GROQ_FALLBACK_MAX_SEC` (default 1 h).
- Longer videos -> **NVIDIA Nemotron** if `NVIDIA_API_KEY` is set; otherwise the job waits for local.
- A fallback is one whole new run. Providers are never mixed inside one video, and fallback answers are not cached (PR #72).

### Free-tier quotas
- **Gemini:** limits are per Google Cloud project (requests/min, tokens/min) with a daily request cap shared by every key in that project. Adding keys in the same project does not add quota. ai-dev-1 adds client-side pacing and clear "daily cap reached" handling in #74; until then, long playlists can hit 429s.
- **Groq:** 8k tokens/min and 200k tokens/day. Usable for videos up to about 1 h; that is why the Groq fallback stops at 1 h.
- **NVIDIA NIM:** ~40 requests/min; used only for the long-video fallback.

### Privacy
- On the **free tier, Google may use Gemini prompts and responses** to improve its products (including human review). Transcripts sent to Gemini free tier must be treated as shared with Google. The UI/docs must say so (owner: client-presenter for docs, ui-dev-1 for the provider hint).
- The **local** provider keeps transcripts and notes on the Mac. Users with private or sensitive lectures should choose `local`.
- Colab sends transcripts to the user's own Colab VM through their tunnel (better than a shared API, weaker than the Mac).

### When to use local or Colab
- **Local (Mac M2, 16 GB):** privacy, no quota, very long videos overnight. Model now: **Qwen3-8B-Q4_K_M**. Candidates to evaluate in #75: **Qwen3.5-9B** and **gpt-oss-20b** (both fit 16 GB at 4-bit, gpt-oss-20b is tight; close other GPU jobs).
- **Colab (A100):** when the Mac is needed during long jobs, when more than one long video a day is queued, measured 24 h runs exceed ~10 h, or for higher quality with **Qwen3-32B**. Run the same `llama-server` on Colab behind an https tunnel and set `LNAI_LOCAL_URL` (+ `LNAI_LOCAL_KEY`).

### #39 (Colab runner)
Covered. Since PR #72, `local` accepts an https URL with a bearer key, which is exactly what #39 asked for (Colab runs `llama-server`, exposes it with cloudflared, the app points `LNAI_LOCAL_URL` at it). No separate provider is needed; `colab` remains only as a deprecated alias. #39 moves to QA for the user to verify.

### Evaluation
#75 will measure quality, time and quota use for Gemini, Groq, NVIDIA, local Qwen3-8B and the candidates on the same sample transcripts (short, 1 h, long). If results disagree with this ADR (for example local beats Gemini on quality, or Gemini quotas block normal use), a new ADR supersedes the relevant section.

## Consequences

- Positive: fast notes out of the box with no setup; long videos still have a path (local, NVIDIA, Colab); one rule for fallback; privacy trade-off written down.
- Negative: the default sends transcripts to Google on the free tier; Gemini daily caps can stall large playlists until #74 lands; quality claims are unmeasured until #75.
- Follow-ups: #74 (ai-dev-1, Gemini pacing), #75 (evaluation), privacy note in UI/docs (ui-dev-1, client-presenter), user QA of #39.

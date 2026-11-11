# R5 evaluation: local Qwen3-8B vs Groq

- **Card:** https://github.com/secretJod/AqSpace/issues/34
- **Tester:** <your name>, with the qa-guide agent
- **Date:** YYYY-MM-DD
- **Machine:** MacBook M2 16 GB, model `Qwen3-8B-Q4_K_M` via `scripts/llm.sh start`

## Why we do this
The test plan (`docs/qa/r5-local-model.md`) checks that the feature *works*. This evaluation checks that it is *good enough*: is it fast enough on your Mac, does every job finish, and are the notes at least as good as Groq's? We use the same 5 videos every time so results can be compared after future changes.

## The 5 videos (fill in once, then keep them fixed)

| # | Type | How to choose | Link | Length |
|---|---|---|---|---|
| V1 | Short | 10-20 min lecture with captions, one clear topic | ______ | ____ |
| V2 | 1 hour | 50-70 min university-style lecture with captions | ______ | ____ |
| V3 | Very long | 10 hours or more (full course, livestream recording), with captions | ______ | ____ |
| V4 | Technical | 20-40 min with formulas or code on screen and spoken (maths, physics, programming) | ______ | ____ |
| V5 | No captions | 10-30 min, YouTube shows no CC button (check under Settings > Subtitles) | ______ | ____ |

Tips: pick topics you know a little, so you can judge accuracy. Avoid music videos and private or age-restricted videos. V1 and V4 must be short enough for Groq (under about 40 minutes); these are the two side-by-side videos.

## Part A: speed and reliability (local model)
For each video: model running, make notes, write the start and end time.
- **Minutes to notes:** end minus start.
- **Minutes per hour of video:** minutes to notes / video length in hours (e.g. 12 min for a 30-min video = 24 min/h).
- **Failures:** how many times it errored or got stuck; write the error text.
- **Fallback used?** Yes if the logs show `groq` for this job: `docker compose logs notes-ai | grep -i -E "provider|groq" | tail`. It should be **No** for all five while the model is running.

| # | Minutes to notes | Min per hour of video | Failures (count + error) | Fallback used? | Finished? |
|---|---|---|---|---|---|
| V1 | | | | Yes / No | Yes / No |
| V2 | | | | Yes / No | Yes / No |
| V3 | | | | Yes / No | Yes / No |
| V4 | | | | Yes / No | Yes / No |
| V5 | | | | Yes / No | Yes / No |

## Part B: quality side by side with Groq (V1 and V4)
1. Make local notes (Part A already did this). Save them as PDF: `V1-local.pdf`, `V4-local.pdf`.
2. Stop the model (`scripts/llm.sh stop`) so the app falls back to Groq. Make notes for V1 and V4 again. Save them as `V1-groq.pdf`, `V4-groq.pdf`. If the app reuses the old notes, ask the qa-guide agent how to force a fresh run.
3. Rename the files to **A** and **B** (ask someone to do it, or flip a coin) so you don't know which is which while scoring. Write down the key somewhere hidden.
4. Watch or skim the video, read both notes, and score each 1-5:
   - **Accuracy:** no wrong facts, formulas or code. (1 = many mistakes, 5 = none)
   - **Coverage:** all main points of the video are there. (1 = most missing, 5 = nothing important missing)
   - **Structure:** clear headings, order follows the lecture. (1 = jumbled, 5 = very clear)
   - **Readability:** easy to read and study from. (1 = hard, 5 = easy)
5. Reveal which was local and which was Groq, and fill the table.

| Video | Engine | Accuracy | Coverage | Structure | Readability | Average |
|---|---|---|---|---|---|---|
| V1 | Local | | | | | |
| V1 | Groq | | | | | |
| V4 | Local | | | | | |
| V4 | Groq | | | | | |

**Local average (V1+V4):** ____  **Groq average (V1+V4):** ____

Notes (things one did better than the other):

## Pass rule
The evaluation **passes** only if both are true:
1. **Local average >= Groq average** in Part B.
2. **Every job finishes** in Part A (all five "Finished?" = Yes), with "Fallback used?" = No while the model was running.

- [ ] **PASS**: comment on card #34: `Eval PASS: local x.x vs Groq y.y, 5/5 finished, V3 took __ min for __ h.`
- [ ] **FAIL**: file one bug per failed row (below), then comment the summary on card #34.

## How to file a bug from a failed row
1. Pick the row that failed (for example "V3, Finished? = No").
2. Save the logs: `docker compose logs notes-ai --since 2h > v3-logs.txt` and `scripts/llm.sh status`. Check the file for API keys and remove them.
3. Use the bug format from `docs/qa/TEMPLATE.md`. Example:
   ```
   **Bug:** 10h video stops at chunk 41/120 and never finishes
   **Plan step:** r5-eval.md Part A, row V3
   **Where:** MacBook M2, localhost:5180, model running
   **Steps to reproduce**
   1. scripts/llm.sh start; docker compose up -d
   2. Import <V3 link>, press make notes
   3. Wait
   **Expected:** notes finish
   **Actual:** progress stuck at 41/120 for 30 min; log says "<copy error>"
   **How often:** always (2 of 2 tries)
   **Screenshot / logs:** v3-logs.txt attached
   ```
4. Post it on the right card: speed or crashes in the model server go to **#37**; resume, chunking or fallback problems to the notes-ai owner card; low quality scores to **ai-dev-1** (prompts). Not sure? Post it on #34 and the qa-guide agent will route it.
5. A low quality score is a bug too: say which video, which score, and paste the wrong sentence next to what the video actually said.

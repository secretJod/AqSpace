# First run: start AQspace and smoke-test it (card #79)

One page for the QA tester. Branch: `preview/latest`. Notes use **Gemini** by default, **Groq** is the backup, and the local model (llama.cpp) is **not installed**, so it shows as offline. That is expected.
Detailed plans: [r5-local-model.md](r5-local-model.md), [47-upstream-import.md](47-upstream-import.md).

## 1. Before you start
1. **Docker Desktop is running**: the whale icon in the menu bar says "Docker Desktop is running".
2. **Memory cap**: Docker Desktop > Settings > Resources > Memory set to **at least 6 GB** (Whisper and the PDF browser are heavy). Click Apply & restart.
3. **Key format check** (file `lecture-notes-ai/backend/.env`). Never paste, print or screenshot the key. These commands answer only with a number, never the key:
   ```bash
   cd ~/WorkSpace/AQspace
   grep -c '^GEMINI_API_KEY=AIza' lecture-notes-ai/backend/.env          # want: 1
   grep '^GEMINI_API_KEY' lecture-notes-ai/backend/.env | grep -c "[ \"']"  # want: 0
   ```
   The line must look like `GEMINI_API_KEY=AIza...` on one line, with no spaces around `=`, no quotes, and no spaces or line breaks inside the key.
   **To fix it:** open the file in TextEdit (`open -e lecture-notes-ai/backend/.env`). Delete the bad line, type `GEMINI_API_KEY=` and paste the key straight from Google AI Studio. Save it, run the two checks again, and close the window. Don't share the file or a screenshot of it. If you ever see a key in a chat, log or bug report, tell the team so the key can be rotated.

## 2. Start it
```bash
cd ~/WorkSpace/AQspace
git checkout preview/latest && git pull
docker compose up --build
```
The first build takes several minutes. Leave the window open. Wait until the `aq-api` logs stop scrolling, then open **http://localhost:5180**.

**Healthy check** (in a second terminal):
```bash
curl -s 'localhost:5180/api/v1/health?deep=1'
```
Healthy looks like this: `"ok":true`, `"db":"ok"`, `"notesService":"ok"`, `"localModel":"offline"`. The local model is not installed today, so `offline` is fine. A `notesService` of `offline` means the notes worker is not up yet; wait 30 s and try again.

## 3. 10-minute smoke test (mark each item pass or fail)
| # | Step | Expected |
|---|---|---|
| 1 | Import a YouTube playlist link | The playlist and its videos appear in the list |
| 2 | Open a short video (under 10 min) and make notes | Provider is Gemini. Notes are ready in about **1 minute** |
| 3 | Open the PDF of those notes | The PDF opens and is readable, with headings and no broken text |
| 4 | Try **Smart arrange** on the playlist | The videos get regrouped/ordered with no error |
| 5 | Check the dashboard | Progress and counts update after step 2 |
| 6 | Check the streak | It shows today's activity |
| 7 | Bottom nav on a phone-sized window (Chrome DevTools > device toolbar, iPhone) | Every tab works and nothing overlaps |
| 8 | Open http://localhost:5180/dev | The developer tracker loads **on your own machine** |
| 9 | (Optional, only if the tunnel is running) Open `/dev` on the trycloudflare link | It must **not** be available through the tunnel |

## 4. Common errors
| What you see | What it means / what to do |
|---|---|
| `Google Gemini rejected the API key (HTTP 401/403)...` | The Gemini key is wrong, inactive, or has extra characters. Redo the key check in section 1, then restart (`docker compose up --build`) |
| `No API key for Google Gemini. ... put GEMINI_API_KEY in backend/.env.` | The key line is missing or has the wrong name. See section 1 |
| `The API key contains spaces or unusual characters...` / `...looks invalid (unexpected characters or too long).` | There are quotes, spaces or a line break in the key. See section 1 |
| `Google Gemini daily quota reached...` or `...rate limit reached...` | The free-tier limit was hit. Wait a minute (or until tomorrow for the daily limit), or switch to Groq. This is not an app bug |
| `The local model server is not reachable at LNAI_LOCAL_URL ... Start llama-server` / health shows `localModel: offline` | Expected today because llama.cpp is not installed. Pick Gemini or Groq |
| `The notes service is not running. Start it (docker compose up) and try again.` | The notes worker is down or still starting. Wait, or check `docker compose logs notes-ai` |
| `Cannot connect to the Docker daemon` | Docker Desktop is not running. Start it, wait for the whale icon, then run the command again |
| `port is already allocated` / `address already in use` (5180, 4000, 5173) | Another app is using that port. Stop the other app (or an old run: `docker compose down`) and start again |
| `Too many requests - please slow down a little.` / `The server is busy...` | Built-in protection. Wait a minute |

## 5. Stop it
Press `Ctrl+C` in the window that is running it, then run `docker compose down`. Your data stays in the repo folder.

## 6. Report pass or fail
- **Pass:** on card #79 (and any card you tested), comment "QA pass: first run + smoke test, <date>". Then move the card to **Done** on the [AQspace Board](https://github.com/users/secretJod/projects/2).
- **Fail:** comment on the card with the step number, **Steps / Expected / Actual**, and a screenshot (**never** one that shows the `.env` file or a key). Move the card back to **In Progress**. Use [TEMPLATE.md](TEMPLATE.md) for longer reports. qa-guide records the result in the daily file.

# Google sign-in and the profile menu (card #153)

One page for the QA tester. Branch: `preview/latest`. It covers PRs #154 (Docker settings), #155 (sign-in on the server) and #156 (profile button, sign-in screen, "session has ended" screen).
Sign-in is **off** by default ("local mode": one user, no sign-in). In this test you switch it **on** ("google mode"), test it, and switch it back off.

## 1. Before you start
1. Do the [first run](first-run.md) once, so the app starts and you have **at least one playlist with some progress** (watch part of a video). You need this data for step 5.
2. **Google Cloud Console** (console.cloud.google.com > APIs & Services > Credentials > your OAuth client):
   - Under **Authorized redirect URIs** add exactly: `http://localhost:5180/api/v1/auth/google/callback`. Remove the old one that ends in `5173`, if it is there.
   - Under **Authorized JavaScript origins** add: `http://localhost:5180`.
   - Click **Save**. Google can take a few minutes to apply it.
   - Under **OAuth consent screen**: if "Publishing status" says **Testing**, add each Google account you will test with under **Test users**. Other accounts are refused by Google.
3. **The settings file.** Open the root `.env` in TextEdit (`open -e ~/WorkSpace/AQspace/.env`). Never paste, print or screenshot this file, and never paste its values into a chat, card or comment.
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` must already be there (copy them straight from the Google Console page if not).
   - `GOOGLE_REDIRECT_URI=http://localhost:5180/api/v1/auth/google/callback`
   - `SESSION_SECRET=` followed by a fresh random value. In Terminal run `openssl rand -hex 32`, copy the result and paste it straight into the file after the `=`. Don't share it.
   - Leave `AUTH_MODE=local` for now (step 1 needs it). Save the file.
4. Restart: `cd ~/WorkSpace/AQspace && docker compose up -d`. Wait 30 seconds, then open **http://localhost:5180**.

## 2. Steps (tick Pass or Fail for each)

**Local mode (sign-in off)**
- [ ] **1. Profile button.** Look at the round button at the top right of the app. Click it.
  Expected: it shows initials (or a person icon). The menu shows "Local user" and "Single-user mode (sign-in is off)". There is **no** Sign out.
  [ ] Pass [ ] Fail

**Switch to google mode.** In `.env` change the line to `AUTH_MODE=google`, save, run `docker compose up -d`, wait 30 seconds.

- [ ] **2. Sign-in screen.** Open http://localhost:5180 in a **private/incognito window**.
  Expected: a dark card with the AQspace mark and a white "Sign in with Google" button. You never see the app flash behind it.
  [ ] Pass [ ] Fail
- [ ] **3. Sign in.** Click "Sign in with Google" and pick your test account.
  Expected: you come back to the app, signed in, with no error page.
  [ ] Pass [ ] Fail
- [ ] **4. Your profile.** Look at the profile button, then click it.
  Expected: the button shows your Google photo. The menu shows your correct name and email, and a "Sign out" item.
  [ ] Pass [ ] Fail
- [ ] **5. Your data is kept.** Open your playlists and the dashboard.
  Expected: the playlists, progress and notes you made in local mode are all still there (the first Google account to sign in takes them over).
  [ ] Pass [ ] Fail
- [ ] **6. Sign out.** Open the profile menu and click "Sign out".
  Expected: you see the sign-in screen again.
  [ ] Pass [ ] Fail
- [ ] **7. Old session no longer works.** Sign in, open a playlist, then in Chrome: right-click > Inspect > Application > Cookies > `http://localhost:5180`, delete the cookies, close Inspect. Now click something (play a video or open another playlist).
  Expected: a "Your session has ended" screen with a sign-in button. Sign in again: you land back on the same playlist.
  [ ] Pass [ ] Fail
- [ ] **8. Deep link.** Sign out. Paste the address of a single playlist (from the address bar, it looks like `http://localhost:5180/#/playlist/...`) into the private window and press Enter. Sign in.
  Expected: after Google you land on **that same playlist**, not the home page.
  [ ] Pass [ ] Fail
- [ ] **9. Keyboard only.** Put the mouse aside. Press Tab until the profile button is highlighted. Press Enter: the menu opens. Press the Down arrow: "Sign out" is highlighted. Press Esc.
  Expected: the menu closes and the highlight is back on the profile button. Clicking anywhere outside an open menu also closes it.
  [ ] Pass [ ] Fail
- [ ] **10. Phone size.** Chrome Inspect > device toolbar (phone icon) > iPhone. Open the profile menu and the sign-in screen.
  Expected: both fit on screen, nothing overlaps, the buttons are easy to tap.
  [ ] Pass [ ] Fail
- [ ] **11. Tunnel (only if the tunnel is running).** Open the trycloudflare link.
  Expected: you see the sign-in screen, but Google sign-in does **not** finish there (see Known limits). That is expected, not a bug. Note what you saw.
  [ ] Pass [ ] Fail [ ] Blocked (no tunnel)

**Switch back to local mode.** In `.env` set `AUTH_MODE=local`, save, run `docker compose up -d`, wait 30 seconds.

- [ ] **12. Back to normal.** Open http://localhost:5180.
  Expected: no sign-in screen. The app opens straight away and the menu says "Single-user mode (sign-in is off)".
  [ ] Pass [ ] Fail

## 3. Known limits (not bugs)
- **The quick tunnel can't do Google sign-in.** Its web address changes every time it starts, and Google only accepts addresses registered in advance. Sign-in through a tunnel needs a fixed address (a later card).
- **A second Google account starts empty.** Only the first Google account to sign in takes over the existing data. Anyone else gets their own empty space.
- In local mode some data now belongs to your Google account, so after step 12 local mode may look emptier. That is expected.

## 4. Common errors
| What you see | What to do |
|---|---|
| Google says `redirect_uri_mismatch` | The redirect address in Google Console doesn't match exactly. Redo section 1, step 2, wait a few minutes |
| Google says "Access blocked" / app not verified, for your account | Add the account under **Test users** (section 1, step 2) |
| Still no sign-in screen after switching to google | `docker compose up -d` again, and check the `.env` line is exactly `AUTH_MODE=google` |
| Photo missing, initials show instead | Fine if it happens once; report it if it always happens |

## 5. Report pass or fail
- **Pass:** comment on card #153 (and #130, #151, #152) "QA pass: Google sign-in, <date>", then move the cards to **Done** on the [AQspace Board](https://github.com/users/secretJod/projects/2).
- **Fail:** comment on the card with the step number, **Steps / Expected / Actual**, and a screenshot (**never** one that shows `.env`, a key, or Google Console secrets). Move the card back to **In Progress**. Use [TEMPLATE.md](TEMPLATE.md) for longer reports. qa-guide records the result in the daily file.

# How the UI is organized

Plain HTML + CSS + JavaScript. No framework, no build step, no ES modules: every script is a normal `<script>` tag that adds one piece to a single global object, `window.AQ` (for example `AQ.store`, `AQ.player`). Each file is wrapped in an IIFE, `(function () { ... })();`, so its private variables do not leak.

## Folder map

```
lecture-notes-ui/
  index.html                  the only page; links every CSS and JS file (in order)
  css/
    styles.css                base styles for the whole app (loaded first)
    smart-magic.css           "Smart arrange" button + animation
    streak.css                streak card on the dashboard
    achievements.css          achievement-unlocked modal
    navbar.css                bottom navigation bar
    profile.css               AQspace: profile button + menu, sign-in and expired-session screens (loaded last)
    goals.css                 goals card on the dashboard
    sticky-board.css          sticky notes board (dashboard card + expanded board + note editor)
    mirror.css                "obsidian glass" finish for the dashboard panels, core lens and 3D orbit (loaded last)
    dashboard.css             dashboard grid, cards, stat tiles, heatmap, sessions list, "coming soon" screen
  js/
    vendor/
      chart.umd.js            Chart.js 4 (copied from npm; the CSP forbids CDNs) + LICENSE-chartjs.md
    core/                     no screens here, only data and helpers
      util.js                 AQ.util      DOM builders, icons, YouTube ids, durations, "3 days ago"
      store.js                AQ.store     playlists, videos, watch progress (localStorage)
      api.js                  AQ.api       sync with the aq-api server (optional); 401 auth_required -> signed out
    features/profile/profile.js AQ.profile  AQspace: profile button + menu, sign-in and expired-session screens (after api.js)
    ui/                       reusable widgets, not tied to one feature
      dialog.js               AQ.dialog    the modal dialog (focus trap, Esc, confirm box)
      water-button.js         AQ.water     the "liquid glass" button
      click-spark.js          AQ.clickspark  sparks on every click
    features/
      notes/
        notes-jobs.js         AQ.notesJobs, AQ.notes   "Get notes" jobs (start, poll, remember)
        note-button.js        AQ.noteButton            the Get notes / progress / View notes button
        notes-view.js         AQ.notesView             notes panel content (iframe, PDF link)
      player/player.js        AQ.player    YouTube player dialog + saving watch progress
      playlists/
        split-view.js         AQ.split     notes panel next to a shrunken video list
        import-playlist.js    AQ.importPlaylist  "Import from YouTube" dialog
      smart/
        smart-magic.js        AQ.smartmagic  visuals of Smart arrange (charge, burst, glide)
        smart-arrange.js      AQ.smart     Smart arrange run + learning-path drawer
      streak/streak.js        AQ.streak (data), AQ.streakView (card)
      achievements/achievements.js  AQ.achievements  "achievement unlocked" modal (medal, confetti); `?celebrate=blaze` forces it
      navbar/navbar.js        AQ.navbar    bottom navigation bar
      dashboard/
        activity-log.js       AQ.activity     study sessions (minutes per day / hour, totals, recent); real usage only
        activity-hooks.js     records real usage (player, notes) into AQ.activity
        goals.js              AQ.goals (data), AQ.goalsView (card)
        charts.js             AQ.charts       Chart.js wrappers with one dark theme (bar, line, donut, sparkline) + DOM heatmap
        sticky-board.js       AQ.sticky (notes data, localStorage aq.sticky.v1) + AQ.stickyBoard (views)
        dashboard.js          AQ.dashboardView (the dashboard screen), AQ.comingSoonView
    app.js                    routing + home and playlist screens (loaded last)
  demo/
    navbar-demo.html/.js/.css stand-alone page to try the navbar (http://127.0.0.1:5180/demo/navbar-demo.html)
```

Every JS file starts with a header ("What this file does / How it fits / Start reading at") and is split into numbered sections (`// ===== 1. ... =====`).

## Load order

The `<script>` tags in `index.html` run top to bottom. A file may only use `AQ.*` pieces from files **above** it (at load time; inside click handlers anything is fine).

1. `js/core/util.js` (creates `window.AQ`), `store.js`, `api.js`
2. `js/ui/dialog.js`, notes (`notes-jobs.js`, `note-button.js`, `notes-view.js`), `player.js`, `water-button.js`, `click-spark.js`, `smart-magic.js`, `split-view.js`, `import-playlist.js`, `smart-arrange.js`, `motion.js` (AQ.motion: spotlight, tilt, reveal, countUp, aurora), `expand.js` (AQ.expand: card -> full panel), `streak.js`, `achievements.js` (AQ.achievements: watches AQ.streak, wraps AQ.neural.mount), `navbar.js`
   then the dashboard group: `js/vendor/chart.umd.js`, `activity-log.js`, `activity-hooks.js`, `goals.js`, `charts.js`, `sticky-board.js`, `dashboard.js`
3. `js/app.js` last: it uses everything above and draws the first screen.

CSS order matters too (later files can override earlier ones): `styles.css`, `smart-magic.css`, `streak.css`, `navbar.css`, `dashboard.css`, `goals.css`, `sticky-board.css`, `motion.css`, `expand.css`, `achievements.css`, `mirror.css` (last: it re-skins the dashboard).

The dashboard is a bento of glass cards: each card is compact and opens into a full view through `AQ.expand.attach` (dashboard.js, `renderFull`). `?open=<id>` (today, goals, time, best, playlists, continue, split, board, vitals, streak) opens one on load, e.g. `/?open=time#/dashboard`. There is no sample data: `js/core/demo-cleanup.js` (loaded first) removes once per browser what the old `?demo=` switches left behind.

## Data flow (store -> views)

```
 user clicks  ->  app.js / a feature calls AQ.store.addVideo(...) (or create, moveVideo, watchSave ...)
                     |
                  store.js: change the in-memory list -> save to localStorage -> AQ.api.record(...) (to the server)
                     |
                  store.js calls every function registered with AQ.store.subscribe(fn)
                     |
                  app.js render(): rebuilds the current screen from AQ.store.all() / get(id)
```

- The store is the single source of truth for playlists and progress. Screens never keep their own copy.
- Notes jobs work the same way with their own store: `AQ.notesJobs.subscribe(fn)`; buttons and panels re-draw themselves.
- On start `api.js` loads the server's data and calls `AQ.store.applyRemote(...)`, which triggers the same re-render.

## Where to start reading

1. `index.html` (the page skeleton and the script list)
2. `js/core/store.js` (the data model in its header)
3. `js/app.js`, from `render()` at the bottom up to `renderHome()` and `renderDetail()`
4. Then any feature folder you need.

## Glossary

| Name | Meaning |
|---|---|
| `AQ` | the one global object every file adds to |
| `u`, `el`, `$` | `AQ.util`, its element builder `el(tag, class, text)`, and `querySelector` |
| `p`, `pid` | a playlist object, a playlist id (slug like `data-science`) |
| `v`, `vid`, `id` | a video object, a YouTube video id (11 characters) |
| `st` | a "status" or "state" object (meaning depends on the file; see the comment where it is created) |
| `r` | in smart-arrange.js: the run record of one playlist |
| `opts` | an options object passed to a function |
| job | one "Get notes" request on the notes server (notes-jobs.js) |
| watch info | per-video playback progress: `{pos, dur, done}` in seconds (store.js) |
| route | the part of the address after `#`, e.g. `#/playlist/data-science` |
| FLIP | animation trick: measure First and Last positions, Invert with a transform, Play (split-view.js, smart-magic.js) |
| liquid glass | the refracting glass look of some buttons (water-button.js) |

---

# AQspace - playlists screen

The in-app **Playlists** screen: an all-black app UI where you group YouTube lectures into playlists, watch them in order and request hand-drawn notes. Plain HTML/CSS/JS, no build step, no npm.

(The old marketing landing page is preserved in `_landing-backup/` - `index.html`, `styles.css`, `app.js`, `resources.js`.)

## Run

1. (For "Get notes") start the notes server: `D:\AQspace\lecture-notes-ai\start.ps1` and keep it open (listens on http://127.0.0.1:5055).
2. Serve this folder: `powershell -ExecutionPolicy Bypass -File .\serve.ps1`
3. Open **http://127.0.0.1:5173/** (or http://localhost:5173/).

**With the application backend (recommended):** `cd D:\AQspace\aq-api; npm start`, then open **http://127.0.0.1:5180/** - it serves this UI and the API from one origin. `js/core/api.js` then syncs playlists and watch progress with the server (localStorage stays as offline cache; existing local data is imported once), and "Get notes" / "Import from YouTube" go through the API, which caches notes per video. Without the backend the UI works exactly as before (steps 1-3 above). See `D:\AQspace\aq-api\README.md`.

Do not open index.html by double-click: the notes API only accepts `localhost` / `127.0.0.1` origins, and a `file://` page sends `Origin: null`, which it rejects.

## Screens (hash routing, single page)

| Route | Screen |
|---|---|
| `#/` | **Playlists home**: top bar (logo, search by name, avatar placeholder), "Your playlists" + count + the glass **New playlist** button, grid of **chroma cards** (full-bleed first-video thumbnail, greyscale at rest; the pointer reveals colour through a soft spotlight and a per-playlist accent glow; name, "N videos · duration", **watch progress** bar "x of N watched / %", card menu with Rename / Delete-with-confirm), dashed "+ Create playlist" card, empty state. |
| `#/playlist/<id>` | **Playlist detail**: "← Playlists", name, description, stats, actions **Add video / Play all / Rename / Delete**. Video rows: number, thumbnail, title, channel, duration, **Watch / Get notes / Edit / Move up / Move down / Remove** (remove has Undo), drag-and-drop reordering (mouse) plus the Move buttons (keyboard / touch). Empty playlist shows an inline add form. |
| dialogs | Create/rename playlist (name required, max 60, unique case-insensitive; description max 160), edit video (title, channel, optional duration `m:ss` / `h:mm:ss`), delete confirm, player (youtube-nocookie embed, previous/next through the playlist, switch to notes). Focus is trapped, Esc closes, focus returns to the opener. |

### Effects

- **Chroma cards** (`js/app.js` + `.pcard*` in `css/styles.css`): pointer-tracking spotlight that un-greys the cover, accent pair derived from the playlist id. Static when `prefers-reduced-motion`.
- **Glass New playlist button** (`js/ui/water-button.js`): iOS-style liquid glass with SVG refraction, spring hover (swell, wobble, pointer-following rim light) and a jelly press feel. **Click** briefly brightens the rim, the form opens immediately and the global click spark is the click effect.
- **Click sparks** (`js/ui/click-spark.js`): small spark burst on every click anywhere (except text fields, selects and elements with `data-no-spark`; it fires on the glass button too).

**Import from YouTube** (`js/features/playlists/import-playlist.js`, button next to "New playlist"): paste a playlist link, "Fetch" (calls the notes server `GET /api/playlist?url=...`), preview (title, channel, N videos, total time, first thumbnails), edit the name (unique-name rule; "Title (2)" is suggested when taken) and description, then "Import N videos" creates a local copy with one storage write (`AQ.store.createWithVideos(name, desc, videos, source)`; `AQ.store.addVideos(pid, list)` is the batch add) and opens it. The playlist records `source: {type:"youtube", listId, url, importedAt}` and its detail header shows an "Imported from YouTube" badge + "Open on YouTube". Nothing syncs back; you can still add your own videos. Needs the notes server (restart it after updating so the new endpoint exists).

Adding a video: paste a YouTube link (watch / youtu.be / shorts / embed / bare 11-char id). The id is validated, duplicates in the same playlist are rejected, and title/channel come from `https://www.youtube.com/oembed`. If that fails the video is added as "YouTube video <id>" and an "Edit details" link lets you fix the title (oEmbed has no duration, so duration is optional and edited by hand).

## Data model

Stored in `localStorage` key **`aq.playlists.v1`** (JSON array). Seeded on first run only (when the key is absent) with Data Science (`data-science`), AI & Agents (`ai-agents`), Programming (`programming`). If storage is blocked or full the app keeps working in memory and shows a banner.

```
Playlist = { id, name, description, created, updated, videos: [Video] }   // id = slug [a-z0-9-], used in the route
Playlist may also carry  source?: { type: "youtube", listId, url, importedAt }   // set by "Import from YouTube"
Video    = { id /* 11-char YouTube id */, title, channel, duration /* "m:ss" | "h:mm:ss" | "" */, added }
```

Everything read from storage is sanitised (bad ids, duplicate videos, over-long text dropped/trimmed). Changes made in another tab are picked up via the `storage` event. To reset: delete the key in DevTools > Application > Local Storage (the seed comes back).

## Where things live

| File | What to change there |
|---|---|
| `index.html` | page shell: top bar, `#view` (screens are rendered into it), modal markup, script order |
| `css/styles.css` | tokens at the top (`--bg`, `--panel`, `--white`, `--line`, `--font-display`, radii...), then top bar / grid / rows / modal / responsive sections |
| `js/core/util.js` | DOM helpers (`el`, `icon`, `button`), YouTube id parser, thumbnail URL, duration + "time ago" formatting |
| `js/core/store.js` | data layer: seed data (`seedData`), sanitising, CRUD (`create/update/remove`, `addVideo/removeVideo/updateVideo/moveVideo`), persistence, limits (`LIMITS`) |
| `js/core/api.js` | adapter for the aq-api backend: detects it, loads/migrates data, write-through queue (`AQ.api.record`), `AQ.api.available()` |
| `js/ui/dialog.js` | accessible modal host (focus trap, Esc, restore focus) + `confirm` |
| `js/features/player/player.js` | player dialog (embed, previous/next, notes switch) |
| `js/features/notes/notes-jobs.js` | "Get notes" client for the notes API |
| `js/ui/water-button.js` | glass "New playlist" button: `AQ.water.button(label, {icon, onActivate})`; hover springs, lens, jelly press |
| `js/ui/click-spark.js` | click sparks everywhere (vanilla port of React Bits ClickSpark; look = `DEFAULTS` at the top, or `AQ.clickSpark.configure({...})`) |
| `js/app.js` | router + rendering: home grid with chroma cards, watch progress, card menu, playlist form, detail, add form, rows, drag and drop, toasts |
| `screenshots/` | reference screenshots of the screens and effects |
| `_landing-backup/` | previous landing page, untouched |

All user text is inserted with `textContent` / DOM APIs; there is no `innerHTML`.

## Notes API

`POST http://127.0.0.1:5055/api/jobs {url, provider:"groq"}` then poll `GET /api/jobs/<id>` every 2 s; on `done` the PDF link is `/api/jobs/<id>/notes.pdf`. The notes server needs a Groq key in its `backend/.env` (or the request is rejected with a clear message, which the dialog shows). If the server is down the dialog says to start `start.ps1`. Jobs are kept per video id, so closing the dialog does not lose progress.

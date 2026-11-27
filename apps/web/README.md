# AQspace web app

The browser side of AQspace: collect YouTube lectures into playlists, watch them in order, track progress on a
dashboard and turn any lecture into hand-drawn notes.

It is plain HTML, CSS and JavaScript. There is no framework, no bundler and no build step: what is in this folder is
exactly what the browser loads. The API in `apps/api` serves these files on the same origin as `/api/v1/*`.

## Run it

The app needs the API, because the API serves it and stores your data.

```sh
# whole stack (API + worker), from the repo root
docker compose up --build          # then open http://localhost:5180

# or only the API, from apps/api (enough for UI work; notes need the worker)
npm ci && npm start                # http://localhost:5180, serves ../web
```

Edit a file, reload the page. Nothing to rebuild.

Do not open `index.html` from disk (`file://`): the API only answers same-origin requests and the CSP
(`script-src 'self'`) needs a real origin.

Checks, from this folder:

```sh
npm ci                 # ESLint and Prettier, cached in the repo's .npm-cache/
npm run lint           # ESLint (flat config in eslint.config.mjs)
npm run format:check   # Prettier (npm run format rewrites files)
```

### What the server sends

`apps/api/src/routes/ui-static.js` serves only what the page loads: `.html`, `.css`, `.js`, images and fonts.
Dot-files, `package.json`, `*.md`, `*.json`, `*.mjs`, `node_modules/` and tooling configs return 404. So a new
runtime file must be one of those types and live under `css/` or `js/`; config and docs can sit next to them safely.

## How the UI is organised

```
index.html            the only page: page shell, modal markup, every <link>, and the two start-up scripts
css/
  styles.css          base: design tokens, top bar, buttons, dialog, playlist grid and rows, split view
  <feature>.css       one file per feature (streak, goals, dashboard, navbar, profile, ...)
  mirror.css          the glass finish for dashboard panels; loaded late because it overrides dashboard.css
js/
  core/               data and helpers, no screens
    storage.js        AQ.storage browser storage, kept separate per signed-in account (loaded first)
    boot.js           AQ.boot    finds the API, asks who is signed in, then loads every other script in order
    demo-cleanup.js   one-time removal of old sample data from this browser's storage
    util.js           AQ.util    creates window.AQ; el(), icons, YouTube ids, durations, "3 days ago"
    store.js          AQ.store   playlists, videos and watch progress (AQ.storage + subscribe)
    api.js            AQ.api     talks to apps/api: initial load, write-through queue, request()
  ui/                 widgets that are not tied to one feature
    dialog.js         AQ.dialog  the one accessible modal (focus trap, Esc, confirm)
    water-button.js   AQ.water   the "liquid glass" button
    click-spark.js    AQ.clickspark  the spark burst on every click
  features/           one folder per feature
    playlists/        split view (notes next to the list), Import from YouTube
    player/           YouTube player dialog, saves watch progress
    notes/            Get notes jobs, the notes button, the notes panel (with a live preview while notes are written)
    ai/               the user's own AI keys: the key setup card and the "connect a key in Settings" prompt
    settings/         the Settings page (#/settings, from the profile menu): AI keys and which AI does what
    smart/            Smart arrange (best order + missing topics) and its animation
    profile/          profile menu, sign-in and expired-session screens
    navbar/           bottom navigation bar
    streak/           daily streak data and card
    achievements/     "achievement unlocked" celebration
    dashboard/        dashboard screen, charts, goals, sticky board, activity log, HUD effects
  vendor/             Chart.js, vendored because the CSP forbids CDNs (not linted, not formatted)
  app.js              router and the playlist screens; loaded last
```

Every file starts with a header that says what it does, what it depends on and where to read next. Larger files are
split into numbered sections (`// ===== 3. rows =====`).

### One global, classic scripts

Every script is a classic `<script>` (not an ES module) wrapped in an IIFE, so its private variables stay private.
Each file adds its public piece to one global object, `window.AQ`: `AQ.store`, `AQ.player`, `AQ.dashboardView` and
so on. Public functions carry JSDoc.

### Load order

`index.html` loads only `js/core/storage.js` and `js/core/boot.js`. boot.js finds the API, asks who is signed in
(`GET /api/v1/auth/status`), lets `AQ.storage` pick that account's storage, and only then loads every other script
from its `APP_SCRIPTS` list, top to bottom, in five commented groups: core, playlist features, dashboard effects and
streak, the dashboard, and finally `app.js`. While a file loads it may only use `AQ.*` pieces from files above it.
Inside event handlers and render functions anything is fine, because by then every file has loaded. Optional pieces
are checked before use (`if (AQ.split) AQ.split.reset();`), so a missing feature never breaks the page.

CSS order matters too: a later file may override an earlier one.

### Data flow

```
user action -> AQ.store.addVideo(...)          (or create, moveVideo, watchSave, ...)
                 |  store.js: update memory -> save via AQ.storage -> AQ.api.record(...)
                 v
               every AQ.store.subscribe(fn) listener runs
                 v
               app.js render() rebuilds the current screen from AQ.store.all() / get(id)
```

- `AQ.store` is the single source of truth for playlists and progress. Screens never keep their own copy.
- `AQ.notesJobs`, `AQ.activity`, `AQ.goals`, `AQ.sticky` and `AQ.streak` follow the same pattern: read, write,
  `subscribe(fn)`.
- Browser storage is the offline cache. If storage is blocked the app keeps working in memory and shows a banner.

### Browser storage and accounts (`AQ.storage`)

Every feature reads and writes browser storage through `AQ.storage.get / set / remove`, never through
`localStorage` directly. With Google sign-in several people can share one browser, so each account gets its own
namespace; otherwise the next person would see, or upload, the previous person's data.

| Mode                     | Where `aq.goals.v1` is stored |
| ------------------------ | ----------------------------- |
| Sign-in off (local mode) | `aq.goals.v1` (unchanged)     |
| Google, signed in        | `aq.u<userId>.goals.v1`       |
| Google, signed out       | memory only, nothing kept     |

Data is never moved between namespaces: signing out leaves it in place for that account's next sign-in. Before
syncing, `api.js` checks that the server's session is still the account the page started with and reloads the page
otherwise, so offline edits are only uploaded to the account they were made in. A new feature that saves data just
picks a versioned key (`aq.<name>.v1`) and uses `AQ.storage`; the namespace is handled for it.

### Talking to the API (`AQ.api`)

All network calls go through `js/core/api.js`, so there is one base URL, one timeout policy and one place that
handles sign-out.

| Call                                  | What it does                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `AQ.api.ready()`                      | Promise that resolves (true or false) once the API has been found and the first sync is done.       |
| `AQ.api.available()`                  | `true` when the API is reachable and in sync. Features fall back or show an offline message if not. |
| `AQ.api.request(method, path, body?)` | JSON request; resolves `{ status, json }`, rejects only on network failure or timeout.              |
| `AQ.api.record(name, args)`           | Called by `store.js` after every change; queues the matching `/api/v1/playlists/*` call in order.   |
| `AQ.api.signedOut()`                  | `true` after any call returned 401 `auth_required`; later calls short-circuit.                      |

On a 401 `auth_required`, `api.js` stops all traffic once and calls `AQ.profile.authRequired()`, which shows the
sign-in screen. Features never handle sign-out themselves.

### Rules every file follows

- **No `innerHTML` with data.** Titles, names and anything from the API or the user go in with `textContent`,
  `setAttribute` or `AQ.util.el(tag, className, text)`. YouTube ids are validated (11 characters) before they reach
  an embed URL.
- **Accessibility.** Real buttons, visible focus rings, focus moves to the new screen's heading on navigation,
  announcements go to the `#live` region, the dialog traps focus and returns it to the opener.
- **Reduced motion.** Animations check `prefers-reduced-motion` (in CSS, and in JS for canvas or timer
  effects) and shows the final state at once.
- **Storage.** Every `AQ.storage` access is wrapped in `try`, keys are versioned (`aq.playlists.v1`), and data read
  back is sanitised before use.

## How to add a feature

Worked example: a **Notes library** screen at `#/library` that lists every video that has notes, with a nav item in
the bottom bar. It uses the existing `GET /api/v1/notes` endpoint, which answers
`{ notes: [{ videoId, state, pct, ... }] }`.

The files to touch, in order:

### 1. The feature file: `js/features/library/library.js`

```js
/* =====================================================================================================
   What this file does:
     The Notes library screen (#/library): lists every video that has notes on the server.

   How it fits:
     Needs AQ.util and AQ.api (core). app.js mounts it for the #/library route with
     `AQ.libraryView.mount(container)` and calls destroy() when the route changes.
     Styles: css/library.css (classes start with `lib`).

   Start reading at:
     `mount()`.
   ===================================================================================================== */
(function () {
  "use strict";
  var el = AQ.util.el;

  /**
   * Draws the library into `container` and loads the list from the API.
   * @param {HTMLElement} container the #view element
   * @returns {{destroy: function(): void}} removes the screen and ignores a late response
   */
  function mount(container) {
    var alive = true;
    var root = el("section", "lib");
    var h1 = el("h1", "lib__title", "Notes library");
    h1.tabIndex = -1;
    h1.setAttribute("data-focus-fallback", ""); // app.js focuses this after navigation
    var list = el("ul", "lib__list");
    var status = el("p", "muted", "Loading...");
    root.append(h1, status, list);
    container.appendChild(root);

    AQ.api
      .ready()
      .then(function () {
        return AQ.api.request("GET", "/api/v1/notes");
      })
      .then(function (res) {
        if (!alive) return;
        var notes = (res.status === 200 && res.json && res.json.notes) || [];
        status.textContent = notes.length ? "" : "No notes yet.";
        notes.forEach(function (n) {
          // textContent, never innerHTML: the values come from the server
          list.appendChild(el("li", "lib__item", n.videoId + " - " + n.state));
        });
      })
      .catch(function () {
        if (alive) status.textContent = "The server is not reachable.";
      });

    return {
      destroy: function () {
        alive = false;
        root.remove();
      }
    };
  }

  AQ.libraryView = { mount: mount };
})();
```

Shape rules: one IIFE, one public object on `AQ`, a `mount(container)` that returns `{ destroy() }`, user-visible
text through `textContent`, a JSDoc on every public function.

### 2. The styles: `css/library.css`

```css
/* What this file styles:
   The Notes library screen (js/features/library/library.js). Classes start with `lib`.
   Uses the tokens from styles.css. */
.lib {
  display: grid;
  gap: 16px;
}
.lib__item {
  padding: 12px 16px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}
```

### 3. Link both: the stylesheet in `index.html`, the script in `js/core/boot.js`

Add the stylesheet before `profile.css` in `index.html`. Add the script to `APP_SCRIPTS` in `js/core/boot.js`,
anywhere after `api.js` and before `app.js` (group 2 is a good place, because the file only needs core pieces):

```html
<link rel="stylesheet" href="css/library.css" />
```

```js
"js/features/library/library.js",
```

### 4. Add the route in `js/app.js` (section "router")

1. `route()`: add the name to the screen pattern: `/^#\/(dashboard|ai|goals|library)\/?$/`.
2. `renderScreen(name)`: add a branch that sets `document.title = "Notes library - AQspace"` and calls
   `screen = AQ.libraryView.mount(view)`. `render()` already destroys the previous screen.
3. `render()`: include `r.name === "library"` in the condition that calls `renderScreen`.
4. `syncNav(r)` and the navbar's `onSelect`: map the route `library` to the nav id `library`.

### 5. Add the nav item in `js/features/navbar/navbar.js`

Add `{ id: "library", label: "Library", icon: "library" }` to `DEFAULT_ITEMS`, and a `library` entry to `ICON_DEFS`
(a list of SVG elements with their attributes; an unknown name falls back to the dashboard icon). Check that four
items still fit the bar on a phone: the bar width is `--nb-w` in `css/navbar.css`.

### 6. Check it

```sh
npm run lint && npm run format:check
```

Start the API, open `http://localhost:5180/#/library`, and check that the browser console shows no errors (a CSP
error means an inline script or a file type the server does not send). Tab through the screen with the keyboard and
try it with reduced motion turned on.

If the feature needs a new endpoint, that work happens in `apps/api` first; the UI only ever calls
`AQ.api.request(...)`.

## Where to start reading

1. `index.html`: the page shell; then `js/core/boot.js` for the script list and start-up order.
2. `js/core/store.js`: the data model is in its header.
3. `js/app.js`: from `render()` at the bottom up to `renderHome()` and `renderDetail()`.
4. Then whichever feature folder you need.

## Glossary

| Name              | Meaning                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `AQ`              | the one global object every file adds to                                                      |
| `u`, `el`, `$`    | `AQ.util`, its element builder `el(tag, class, text)`, and `querySelector`                    |
| `p`, `pid`        | a playlist object, a playlist id (a slug like `data-science`)                                 |
| `v`, `vid`, `id`  | a video object, a YouTube video id (11 characters)                                            |
| `opts`            | an options object                                                                             |
| job               | one "Get notes" request (notes-jobs.js)                                                       |
| watch info        | per-video playback progress `{ pos, dur, done }` in seconds (store.js)                        |
| route             | the part of the address after `#`, e.g. `#/playlist/data-science`                             |
| FLIP              | animation trick: measure First and Last positions, Invert with a transform, Play (split view) |
| `?open=<id>`      | opens one dashboard card on load, e.g. `/?open=time#/dashboard`                               |
| `?celebrate=<id>` | shows the achievement modal for a badge, for testing (e.g. `?celebrate=blaze`)                |

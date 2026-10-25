# AQspace - 5-minute demo script

A click-by-click walkthrough for showing AQspace v0.1 to a client. Talking points are in *italics*.

## Before the call (15 minutes ahead)

1. Keep the host Mac plugged in and stop it from sleeping. Open Docker Desktop.
2. Start the app with the public link:
   ```bash
   docker compose --profile tunnel up
   ```
   Add `--build` only if the code changed since the last start. A first build takes a long time, so never do one right before a demo.
3. In a second terminal, get the public link:
   ```bash
   docker compose logs tunnel | grep trycloudflare.com
   ```
   Open that link and check that the Playlists screen loads. The link is new every time the tunnel starts, so always copy it fresh.
4. **Warm up the notes.** Make a playlist called "Demo" with 2-3 short lectures that have captions. Click **Get notes** on one and wait until the notes are ready. This is your backup.
5. Pick a second short video (5-10 minutes, with captions) to generate notes for live. Keep its YouTube link handy.
6. Keep http://localhost:5180 open in another tab in case the public link fails.

## The demo

### 0:00-0:30 - The idea
- Show the **Playlists** home screen.
- *"AQspace turns YouTube lectures into study notes. You bring the lectures, it writes the notes, and it keeps track of what you've watched."*

### 0:30-1:15 - Playlists
- Move the pointer over a playlist card. The cover comes into colour where the pointer is.
- Point out the video count, total length and progress bar.
- Click **New playlist**, type a name and save it.
- *"Each playlist shows at a glance how far you've got."*

### 1:15-2:00 - Import from YouTube
- Open the new playlist and use **Import from YouTube**. Paste the link to your live video (or a short playlist).
- Show the videos appearing. Drag one to reorder it, or use **Move up**.
- *"No copying titles by hand. Paste a link and the whole playlist comes in."*

### 2:00-3:30 - Get notes (the main moment)
- Click **Get notes** on the live video. Show the "working" state.
- While it runs: *"AQspace reads what the lecturer says and writes it up as hand-drawn notebook pages. You get a web page and a PDF."*
- When it's ready, open the notes, scroll through a page or two and open the PDF.
- If it takes longer than about 45 seconds, switch to the backup plan below and come back to it at the end.

### 3:30-4:15 - Watch and read together
- Click **Watch** on the video and open the split view: video on one side, notes on the other.
- Use next/previous to move through the playlist.
- *"Study the way you'd want to, with the lecture and the notes on one screen."*

### 4:15-4:45 - Progress and phone
- Go back to the home screen and show that the progress bar has moved.
- Optional: open the same public link on a phone to show the mobile layout.
- *"It remembers where you stopped."*

### 4:45-5:00 - Honest close
- *"This is v0.1, running on our machine. Next up: Google sign-in so everyone gets their own space, automatic testing, and a backup AI provider so notes keep working if one service is slow."*

## Backup plan

| Problem | What to do |
|---|---|
| **Notes are slow or the AI fails** | Say *"the AI service is busy, here's one I made earlier"* and open the warmed-up video in the "Demo" playlist. Its notes load instantly because they are saved. Check on the live one at the end. |
| **Public link doesn't load** | Switch to the http://localhost:5180 tab and share your screen instead. |
| **Tunnel restarted** | Run `docker compose logs tunnel \| grep trycloudflare.com` again and send the new link. Old links stop working. |
| **No internet at all** | Share your screen on localhost. Show the playlists, saved notes and progress. Explain that importing and new notes need internet. |
| **YouTube import fails** | Use the existing "Demo" playlist and carry on. |
| **App not responding** | Run `docker compose restart aq-api`. Or show the screenshots in `lecture-notes-ui/screenshots/` (`playlists.png`, `playlist-detail.png`, `notesview-ready.png`, `split-open.png`, `mobile.png`). |

## Things not to promise
- No logins or private accounts yet. Everyone with the link sees the same data.
- The public link is temporary and only works while the host Mac is on.
- Every note request uses our shared AI key.

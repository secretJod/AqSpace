# AQspace v0.1 - Release notes

*October 2026*

## What AQspace is

AQspace turns YouTube lectures into study notes. You paste a lecture video or a whole playlist, and AQspace writes neat, hand-drawn-style "field notebook" notes from what the lecturer says. You get each set of notes as a web page and as a PDF.

It also gives you a place to organise your lectures: group videos into playlists, watch them in order, and pick up where you left off.

## What you can do today

- **Make playlists.** Create, rename and delete playlists. Each playlist shows a cover picture, how many videos it has, how long it runs and how much of it you have watched.
- **Import from YouTube.** Bring in a YouTube video or a whole playlist instead of adding videos one by one.
- **Arrange videos.** Add, edit, remove (with Undo) and reorder videos. You can drag them or use the Move up / Move down buttons.
- **Watch inside the app.** Play a video, then go to the previous or next one in the playlist.
- **Get notes.** Click "Get notes" on any video. AQspace shows that it is working, then opens the finished notes. Notes are saved, so asking again for the same video is instant.
- **Watch and read side by side.** Open the video and its notes together on one screen.
- **Keep your place.** AQspace remembers how much of each video you have watched and shows your progress for every playlist.
- **Use it on a phone.** The screens adjust to small screens.
- **Share a public link (optional).** You can open AQspace to people outside your network with a temporary web link (see the limits below).

## How to start it

You need Docker Desktop running on the Mac that hosts AQspace. Nothing else has to be installed.

1. Put the Groq AI key in `lecture-notes-ai/backend/.env` (one line: `GROQ_API_KEY=...`).
2. Make sure the project's main `.env` file exists. The project includes a separate Google sign-in test app that needs it.
3. Start everything:
   ```bash
   docker compose up --build
   ```
   The first start downloads a lot and can take a long time. Later starts are quick.
4. Open **http://localhost:5180** in a browser on that Mac.

To get a public link as well:
```bash
docker compose --profile tunnel up --build
docker compose logs tunnel | grep trycloudflare.com
```
The second command prints a link that ends in `trycloudflare.com`. Stop everything with `docker compose down`.

## Known limits

- **No login yet.** AQspace has no accounts. Everyone who opens it sees the same playlists and notes.
- **One shared AI key.** Every note request uses the host's Groq key. If you share the public link, anyone with it uses that key and its usage limits.
- **The public link changes.** It is a temporary Cloudflare "quick tunnel" link. You get a new link every time the tunnel restarts, so send the new one out each time.
- **The Mac must stay on.** AQspace runs on the host Mac. If the Mac sleeps, shuts down, goes offline or Docker stops, the app and the public link stop working.
- **Notes take time.** A long lecture can take a minute or more, and notes depend on the AI service being available. Videos without captions or a transcript may not produce notes.
- **Data lives on one machine.** Playlists and notes are stored inside the project folder on the host Mac. Nothing is backed up anywhere else.

## Coming next

These pieces are in progress and are **not** part of v0.1:

- **Sign in with Google** so each person gets their own space.
- **Automatic checks (CI)** that test every change before it is accepted.
- **A backup AI provider** so notes still work when the main AI service is slow or down.

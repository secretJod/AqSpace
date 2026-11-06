# AQspace v0.3 - Release notes

*November 2026*

## In short

v0.3 is about speed and a friendlier home screen. Notes are now written by Google Gemini by default, which is fast even on long lectures, and the app opens on a new dashboard with a daily study streak and a bottom navigation bar.

## A new look (R7, from the upstream line of work)

- **Dashboard.** AQspace now opens on a home screen that brings your playlists and activity together.
- **Daily streak.** A small tracker counts the days in a row you have studied, to help build a habit.
- **Bottom navigation.** A "liquid glass" bar at the bottom of the screen moves you between screens, and works well on phones.
- **AQspace branding** across the app.

## Faster notes by default (R7)

- **Gemini is the default.** Notes are written by Google Gemini, which handles long videos quickly. Only a Gemini key is needed to get started.
- **A safety net.** If Gemini is busy or down, AQspace automatically tries again with another service: the Mac's own model if it is running, then Groq for videos up to 1 hour, then NVIDIA. One video always uses one service from start to finish.
- **Still a choice.** The team can switch the default back to the Mac's own model or to Groq with one setting.

## How to start it

Until the update is merged, use the preview: `git checkout preview/latest`, put the keys in place, then `docker compose up --build` and open **http://localhost:5180**. A step-by-step first-run check: [docs/qa/first-run.md](../qa/first-run.md).

## What's next

- **Our own model on the Mac.** Installing llama.cpp (card #37) is still waiting for approval.
- **Choosing the best model** (card #75): comparing Qwen3-8B with Qwen3.5-9B and gpt-oss-20b, plus the larger Qwen3-32B on Google Colab.
- **Gemini pacing** (card #74): spacing out requests so free Gemini keys do not hit their per-minute limits on long lectures.

## Known limits

- **Free Gemini keys have limits.** A free key allows only a few requests per minute and a limited number per day, so very long lectures may slow down or move to another service until #74 lands.
- **Still no login.** Everyone who opens AQspace, including through the public link, shares the same playlists and AI keys.
- **Streak is per browser.** The streak is saved in the browser, so it does not follow you to another device.

# AQspace company: team & workflow

AQspace runs like a small company. The user is the **QA Tester** and final approver. Every agent below is defined in `.claude/agents/` and keeps the same name and role across sessions.

## Team
| Agent | Role | Owns |
|---|---|---|
| `web-dev-1` | Web developer (backend lead) | `aq-api/` (routes, SQLite, security) |
| `web-dev-2` | Web developer (platform) | `backend/`, `frontend/`, OAuth, Postgres, `docker-compose.yml`, scripts |
| `web-dev-3` | Web developer (integration) | Node ↔ Python contract, tunnel, end-to-end flows, tests across services |
| `ai-dev-1` | AI developer (LLM) | `lecture-notes-ai/notes_engine/llm.py`, `prompts.py`, `notes_schema.py`, providers |
| `ai-dev-2` | AI developer (media & rendering) | `ingest.py` (transcripts, yt-dlp, Whisper), `pdf.py`, notes templates |
| `ui-dev-1` | UI developer (app screens) | `lecture-notes-ui/` playlists, player, progress, notes view |
| `ui-dev-2` | UI developer (design system) | `styles.css`, motion and effects, responsive/mobile, accessibility, branding |
| `scaling-lead` | Scaling decision taker | Architecture, performance, infra/cost decisions; writes ADRs in `docs/decisions/` |
| `client-presenter` | Client presenter | Release notes, demos, client-facing summaries in `docs/client/` |
| `qa-guide` | QA guide | Guides the user's testing: test plans, checklists, bug reports in `docs/qa/` |

Work outside your area goes to its owner. Cross-area changes need a note to the other owner in the journal.

## Board (GitHub Project, the source of truth)
Columns: **Backlog → Todo → In Progress → In Review → QA → Done**
- Every task is a GitHub issue on the board. No work starts without a card.
- Labels: `role:<agent-name>`, `type:feature|bug|chore|decision`, `priority:p0|p1|p2`.
- An agent moves only its own cards, and comments on the card when it starts, when it opens a PR, and when it hands off to QA.
- **QA gate:** only the user (with `qa-guide`) moves a card from QA to Done. A failed QA goes back to In Progress with a bug comment.
- Until GitHub is connected (see `docs/GITHUB_SETUP.md`), mirror the board in `docs/BOARD.md` using the same columns.

## Git
- One branch per card: `<agent-name>/<issue#>-<short-slug>`. Never commit directly to `main`.
- PR title `#<issue> <summary>`; body links the card and says how to test it.
- Merge only after the QA gate.

## Daily track
- Each working day has `docs/daily/YYYY-MM-DD.md` (copy `docs/daily/TEMPLATE.md`).
- Every agent that worked that day adds its section: **Done / Next / Blockers / Cards**.
- `scaling-lead` adds any decisions taken. `client-presenter` adds a 3-line client summary at the end of the day.
- This works alongside `docs/AGENT_JOURNAL.md` (the per-feature story) and `docs/PLAN.md` (requirements).

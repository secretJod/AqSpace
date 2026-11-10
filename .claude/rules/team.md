# AQspace company: team & workflow

AQspace runs like a small company. The user is the **QA Tester** and final approver. Every agent below is defined in `.claude/agents/` and keeps the same name and role across sessions.

## Team
| Agent | Role | Owns |
|---|---|---|
| `web-dev-1` | Web developer (backend lead) | `aq-api/` (routes, SQLite, security) |
| `web-dev-2` | Web developer (platform) | `docker-compose.yml`, Dockerfiles, deploy and dev scripts |
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
**AQspace Board**: https://github.com/users/secretJod/projects/2 (repo `secretJod/AqSpace`)
- `scripts/board.sh list` shows every card; `scripts/board.sh move <issue#> "In Progress"` moves one.
- `scripts/gh.sh` is the repo-local GitHub CLI; use it for issues, comments and PRs (`scripts/gh.sh pr create ...`).
- In a git worktree, call these with the main checkout's absolute path: `/Users/karanupadhyay/WorkSpace/AQspace/scripts/board.sh` (the gh binary only lives there).

Columns: **Backlog → Todo → In Progress → In Review → QA → Done**
- Every task is a GitHub issue on the board. No work starts without a card.
- Labels: `role:<agent-name>`, `type:feature|bug|chore|decision`, `priority:p0|p1|p2`.
- An agent moves only its own cards, and comments on the card when it starts, when it opens a PR, and when it hands off to QA.
- **QA gate:** only the user (with `qa-guide`) moves a card from QA to Done. A failed QA goes back to In Progress with a bug comment.

## Card and PR standards (keep the board professional)
- **Issue title:** `<Area>: <outcome in plain words>`. Area is one of API, Notes engine, UI, Platform, Integration, QA, Docs, Decision, Release, Bug. No internal codes (R5, F2), file names or issue numbers in titles.
- **Every card:** created from a template in `.github/ISSUE_TEMPLATE/` (Feature: Summary, Why, Acceptance criteria, Out of scope, Notes; Bug: Summary, Steps, Expected, Actual, Impact, Environment). Milestone (v0.x or Backlog), labels `role:` / `type:` / `priority:`, board fields **Priority**, **Area** and **Size**, and linked as a sub-issue of its **epic**.
- **Cards describe user outcomes**, at feature level. No internal codes, branch names, env-var lists or agent instructions in cards; those belong in agent prompts and PRs.
- **Comments are for people:** "Ready for QA: how to test", "QA failed: …", decisions. No progress chatter.
- **Work-in-progress limits:** at most 3 cards In Progress and 5 in QA. When QA is full, nobody starts new work.
- **Titles stay true:** when the plan changes, rename the card; never leave stale titles.
- **PRs:** title `#<issue> <outcome>`. A PR that is folded into a release branch is closed with a comment linking the release PR, so only live PRs stay open.
- **Releases:** one release PR per milestone (e.g. "Release v0.3: ..."), merged to main only after the QA tester approves.

## System design
- `web-dev-3` keeps the systemdesignsim.com design in sync with the running app, using the Playwright MCP, after every change that affects the architecture (see `.claude/agents/web-dev-3.md`). The team lead assigns it when such a change merges.
- Screenshots and files from the browser go to `.playwright-mcp/` (gitignored) and are deleted at the end of every task.

## Git
- One branch per card: `<agent-name>/<issue#>-<short-slug>`. Never commit directly to `main`.
- PR title `#<issue> <summary>`; body links the card and says how to test it.
- Merge only after the QA gate.

## Daily track
- Each working day has `docs/daily/YYYY-MM-DD.md` (copy `docs/daily/TEMPLATE.md`).
- Every agent that worked that day adds its section: **Done / Next / Blockers / Cards**.
- Agents working in parallel branches do NOT edit `docs/AGENT_JOURNAL.md` or `docs/daily/` in their branch (that causes merge conflicts). They put their journal entry in the PR description and report it to the team lead, who appends journal and daily entries on `main`.
- `scaling-lead` adds any decisions taken. `client-presenter` adds a 3-line client summary at the end of the day.
- This works alongside `docs/AGENT_JOURNAL.md` (the per-feature story) and `docs/PLAN.md` (requirements).

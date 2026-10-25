# Plan & agent journal tracking

Two shared files track this project. Every agent must follow these rules.

## 1. `docs/PLAN.md` — the application plan
- The single source of truth for what we are building.
- Change it **only when the user asks**.
- Every change adds a dated entry to the **Changelog** at the bottom: date, what changed, why, who requested it.
- Never silently rewrite history: mark superseded items ~~struck through~~ (with a note) instead of deleting them.
- Requirements are numbered (R1, R2, ...) in the order the user gives them.

## 2. `docs/AGENT_JOURNAL.md` — shared agent talk space
- Append-only. Newest entries go at the bottom.
- After finishing any feature, fix, or meaningful change, the agent writes an entry **in first person**, telling its own tale:

```
## [YYYY-MM-DD HH:MM] <agent name/role>: <feature title>
**Before:** how things worked / what was missing
**What I did:** changes made, key files touched
**What it solved:** the problem fixed / value added
**Notes for the next agent:** caveats, TODOs, gotchas
```

- Never edit or delete another agent's entry. Corrections go in a new entry.

## Before starting work
Read `docs/PLAN.md` and the latest entries in `docs/AGENT_JOURNAL.md`.

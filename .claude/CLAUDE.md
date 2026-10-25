# AQspace — Project Memory

Read this at the start of every session. These rules apply to every agent and subagent.

## Always, before doing any work
1. Read `docs/PLAN.md`, the living application plan.
2. Read the latest entries in `docs/AGENT_JOURNAL.md` to see what other agents did.

## Always, after doing any work
- Append a first-person entry to `docs/AGENT_JOURNAL.md` (Before / What I did / What it solved / Notes for the next agent).
- If the user asked for a plan change, update `docs/PLAN.md` and add a Changelog row. Never change the plan without being asked.

## Company team
AQspace runs as a fixed agent team (`.claude/agents/`) with a kanban board and daily standups. The user is the QA tester and the only one who moves cards to Done. Read `.claude/rules/team.md`, route work to the owning agent, and keep `docs/daily/` up to date.

## Rules
- Team & board workflow: `.claude/rules/team.md`
- Tracking rules: `.claude/rules/tracking.md`
- Storage rules (everything stays inside the repo): `.claude/rules/storage.md`

## Working style
The user gives requirements one at a time. Add each one to PLAN.md as R1, R2, ... and build step by step.

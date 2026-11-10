# Architecture Decision Records

One file per decision: `NNNN-<slug>.md` with Context / Options / Decision / Consequences / Follow-ups. Owned by scaling-lead. A superseded ADR stays in place and gets a "Superseded by" line.

| # | Title | Status | Date | Card |
|---|---|---|---|---|
| [0001](0001-retire-separate-oauth-app.md) | Retire the separate React/Postgres OAuth app; auth lives in aq-api | Accepted (code removal pending user approval) | 2026-10-25 | #6 |
| [0002](0002-aq-api-database.md) | aq-api stays on SQLite for now; Postgres when a named trigger fires | Accepted | 2026-10-25 | #6 |
| [0003](0003-local-llm-qwen3-8b.md) | Local notes model: Qwen3-8B (GGUF) on llama.cpp with Metal | Accepted | 2026-11-01 | #37 |
| [0004](0004-upstream-convergence.md) | Converging upstream feature/dev-tools with AQspace R5 | Accepted | 2026-11-03 | #47 |

# AQspace data platform: usage and feedback analytics (#138)

Owner: scaling-lead. Decision record: [ADR-0006](../decisions/0006-data-platform.md). Date: 2026-11-09.

## Honest sizing
A handful of users today; at 1,000 users and ~6,000 notebooks/month we would produce maybe 1-3 million events a year, well under 1 GB of Parquet. That fits in one file on a laptop. So the design is **the same pipeline shape the big warehouses use, built on tools that cost $0 now**: events table -> Parquet on disk/S3 -> dbt -> DuckDB -> Metabase. Each layer has a named upgrade and a trigger.

## 1. Event catalogue

Common envelope (every event):
`event_id` (uuid), `ts` (UTC ISO), `name`, `schema_v`, `user_hash` (HMAC-SHA256 of user id with a server secret, rotated yearly; never the email), `session_hash`, `app_version`, `env` (dev/staging/prod), `props` (JSON, per-event below).

### Notes job lifecycle (source: aq-api notes-service + notes-ai Usage)
| Event | Props | Why |
|---|---|---|
| `notes_job_queued` | job_id, video_id, duration_sec, has_captions, playlist_size_bucket | volume, funnel |
| `notes_job_started` | job_id, provider, model, queue_wait_ms | queue health |
| `notes_job_chunk` (sampled) | job_id, chunk_idx, chunks_total, latency_ms, tokens_in, tokens_out | latency per provider |
| `notes_job_quota_hit` | job_id, provider, kind (rpm/daily/budget), wait_ms | quota planning (llm.py `_TransientError.daily_quota`) |
| `notes_job_fallback` | job_id, from_provider, to_provider, reason_code | fallback rate (llm.py `_fallback_target`) |
| `notes_job_finished` | job_id, status (done/error/expired), provider, model, duration_ms, chunks, tokens_in, tokens_out, est_cost_usd, transcript_source (captions/whisper), cache_hit, error_code | success rate, cost |

`error_code` is a fixed enum (`quota`, `transcript_unavailable`, `provider_5xx`, `timeout`, `pdf_render`, `other`), never the raw error message.

### User actions (source: aq-api routes)
`playlist_imported` (n_videos), `video_played` (pct bucket), `notes_viewed` (job_id), `notes_downloaded` (format pdf/md), `smart_arrange_run` (n_videos, status), `streak_updated` (streak_days), `login` (method).

### Explicit feedback (new; follow-up card)
`notes_rated`: job_id, provider, model, `thumb` (up/down) **or** `rating` (1-5), optional `comment` (free text, max 500 chars, stored in the app DB `notes_feedback` table, not in the events stream; the event only carries `has_comment`). One rating per user per notebook, editable.

### What we NEVER collect
- API keys, OAuth tokens, session cookies, secrets of any kind.
- Transcripts, notes content, prompts or model outputs.
- Raw IP addresses, user agents beyond browser family, emails or names in events.
- Free-text error messages from providers (they can echo input).
The existing dev tracker (`aq-api/src/dev.js`) already masks paths and drops bodies; the events writer follows the same rules and has a unit test asserting the allow-list of prop keys.

## 2. Pipeline design

```
 aq-api (Node)            notes-ai (Python)
   | emit(name, props)       | Usage{provider, model, tokens, latency, fallback}
   v                         | returned to aq-api in the job result
 events table (SQLite/Postgres, append-only)  <----+
   | nightly export (step 2)                       
   v
 Parquet files  analytics/raw/events/dt=YYYY-MM-DD/*.parquet
   (repo-local .data/analytics/ today; S3 bucket later)
   v
 dbt (dbt-duckdb)  staging -> intermediate -> marts
   v               (stg_events, fct_notes_jobs, fct_feedback, dim_users, mart_daily_kpis)
 DuckDB file  .data/analytics/aq.duckdb   (MotherDuck or Snowflake later)
   v
 Metabase (docker, local)  ->  dashboards: Notes health, Providers, Feedback, Retention
```

- **Collection:** an append-only `events` table in aq-api's DB (same transaction as the action, so no lost events), written through one `track()` helper with the allow-list. JSONL devlogs stay as the developer tracker; they are the source for step 1 only.
- **Storage:** daily export to Parquet partitioned by `dt`; rows older than 30 days deleted from the app DB after a successful export.
- **Transformation:** dbt project `analytics/dbt/`, tests for uniqueness of `event_id`, accepted values for enums, freshness.
- **Warehouse:** DuckDB (see below).
- **Dashboards:** Metabase OSS in docker-compose (bind-mounted under `./.data/metabase`). QuickSight only if we are on AWS and want SSO; Superset if we outgrow Metabase.

All local paths sit under gitignored `./.data/` and get cleaned by `scripts/nuke.sh` (storage rules).

## 3. Warehouse choice

| Option | Cost at our size | Ops effort | Fit now | When it makes sense |
|---|---|---|---|---|
| **DuckDB (+ MotherDuck later)** | $0 local; MotherDuck free tier then ~$25+/month | None: a file + pip package | **Best**: GB-scale, reads Parquet/JSON directly, dbt-duckdb mature | Up to ~100s of GB, a few analysts |
| Postgres (reuse RDS) | $0 extra until it competes with the app | Low; but analytics queries load the OLTP DB | OK for first dashboards | If we never want a second system |
| BigQuery | Free tier 1 TB queries + 10 GB storage/month, then $6.25/TB scanned | Low (serverless), GCP account | Good if we were on GCP (Gemini is) | Event volume > 100 GB, many ad-hoc users |
| **Snowflake** | Minimum realistic ~$25-50/month for an X-Small warehouse used 1 h/day (1 credit/h, ~$2-3/credit Standard) + storage ~$23/TB; easily $200+/month with dashboards hitting it | Low, but cost governance needed (auto-suspend, resource monitors) | Overkill | Several analysts/BI users, data sharing with clients/partners, > ~1 TB or SLAs on BI concurrency |
| **Databricks** | DBU-based; SQL Serverless ~$0.70/DBU-h, a 2X-Small = 4 DBU/h -> ~$3/h when running; plus cloud compute | Highest: workspace, clusters, Unity Catalog | Overkill | ML-heavy work on our own data: fine-tuning/evaluating our notes model on large feedback + transcripts sets, Spark-scale processing, streaming |

Prices are list prices as published on vendor pricing pages (snowflake.com/pricing, databricks.com/product/pricing, cloud.google.com/bigquery/pricing, motherduck.com/pricing) as of 2026; verify before any purchase.

**Recommendation now: DuckDB + dbt + Metabase**, all local/open source, data as Parquet so it is portable to any later warehouse.

**Switch triggers:**
- To **MotherDuck** (managed DuckDB): more than one person needs dashboards remotely, or we move to AWS (phase 2 of aws.md).
- To **Snowflake**: any two of: > 5 regular BI users; > 500 GB of data or queries > 30 s on DuckDB; a client asks for data sharing; we need role-based access and audit on analytics. Snowflake beats Databricks for us because our workload is SQL/BI, not Spark/ML.
- To **Databricks**: we start training or systematically evaluating our own model (ADR-0003 path) on large labelled sets (ratings + content with consent), or need streaming/Spark. Not before.

## 4. Key metrics (first dashboard)
| Metric | Definition |
|---|---|
| Notes success rate | done / (done + error + expired) per day and provider |
| Time per lecture hour | median(duration_ms) / (video duration_sec/3600), by provider and transcript_source |
| Provider fallback rate | jobs with a `notes_job_fallback` / jobs started |
| Quota hit rate | jobs with >= 1 `notes_job_quota_hit` / jobs started |
| Cost per notebook | sum(est_cost_usd) / done jobs (tokens x provider price table in a dbt seed) |
| Rating by provider/model | avg rating, % thumbs up, n ratings; with 95% CI, hidden below n = 20 |
| Retention | weekly active users, W1/W4 retention cohorts by signup week; streak distribution |
| Funnel | login -> playlist_imported -> notes_job_queued -> notes_job_finished(done) -> notes_viewed -> notes_downloaded / notes_rated |

## 5. Privacy and consent
- Users are told in-app (settings page, first login banner) what we collect; **opt-out toggle** stops all non-essential events (job lifecycle for operations stays, keyed by a null user_hash).
- Feedback comments are opt-in by nature (user types them); shown to the team only, never used for model training without a separate explicit consent.
- Retention: raw events 13 months, then aggregated only; comments 12 months; app-DB copy of events 30 days. Account deletion removes the user's feedback rows and breaks the user_hash link (key rotation + delete mapping).
- Second-Mac and staging data are tagged `env` and excluded from product metrics.

## 6. Feedback loop into the product
- Ratings by provider/model feed the provider choice in ADR-0005: if one provider's rating is lower by >= 0.5 stars (n >= 50) at equal cost, change the default.
- Thumbs-down notebooks with consent form an evaluation set for prompt changes (ai-dev-1) and for judging the local Qwen3-8B (ADR-0003) against Gemini.
- Quota hit and fallback rates drive provider budgets and the GPU trigger in aws.md.
- Funnel drop-offs become cards for ui-dev-1.

## 7. Step 1, runs locally today
`scripts/analytics/report.py` reads `aq-api/data/devlogs/events-*.jsonl` and the `notes_jobs` table (read-only) and prints runs by kind, success rate, median duration and a retry/fallback proxy. Uses DuckDB if importable, else plain Python + sqlite3; installs nothing.

```
python3 scripts/analytics/report.py                     # defaults to aq-api/data/...
python3 scripts/analytics/report.py --devlogs /path/to/devlogs --db /path/to/aq.db --days 7
```
Limitations: devlogs do not yet carry provider, model or fallback (those live in notes-ai's Usage), so "by provider" waits for the events table (FU-1). The SQLite duration is an upper bound because `updated_at` moves on later polls.

## 8. Proposed follow-up cards
| # | Card | Owner | Priority |
|---|---|---|---|
| FU-1 | `events` table + `track()` helper with prop allow-list and tests; job lifecycle events | web-dev-1 | p1 |
| FU-2 | notes-ai returns provider, model, tokens, fallback, quota hits, error_code in job Usage | ai-dev-1 (contract with web-dev-3) | p1 |
| FU-3 | Feedback API: `POST /api/notes/:id/feedback`, `notes_feedback` table | web-dev-1 | p1 |
| FU-4 | Feedback UI: thumbs/1-5 and comment on the notes view | ui-dev-1 (styling ui-dev-2) | p1 |
| FU-5 | Opt-out toggle and privacy notice | ui-dev-1 + web-dev-1 | p1 |
| FU-6 | Nightly Parquet export + dbt-duckdb project + Metabase in compose (under `.data/`, nuke.sh) | web-dev-2 | p2 |
| FU-7 | Second-Mac staging collection (`env=staging`) via the tunnel | web-dev-3 | p2 |
| FU-8 | QA checklist: verify no forbidden fields in events | qa-guide | p2 |

# ADR-0006: Analytics pipeline and warehouse: DuckDB + dbt + Metabase now, Snowflake/Databricks on named triggers

- Status: Proposed (awaiting QA on #138)
- Date: 2026-11-09
- Card: #138 (with #137)
- Owner: scaling-lead

## Context
The product owner wants real usage and feedback data (notes success, provider quality, ratings, retention). AQspace has a handful of users; even at 1,000 users we expect 1-3 M events/year (< 1 GB Parquet). aq-api already writes redacted request and pipeline events to `data/devlogs/*.jsonl`; notes-ai knows provider, model, latency and quota hits but does not yet report them. Storage rules require everything repo-local today.

## Options
1. **DuckDB + dbt + Metabase** on Parquet files (local, later S3/MotherDuck). $0, no ops, fits the size.
2. **Postgres** (the app DB) as the warehouse. Cheap, but analytics load hits OLTP and SQL-on-JSON is clumsy.
3. **BigQuery**. Serverless, generous free tier, but adds a GCP account and data egress from AWS.
4. **Snowflake**. Best-in-class SQL warehouse; minimum real spend ~$25-200+/month and cost governance work for data that fits in RAM.
5. **Databricks**. Strong for Spark/ML; highest ops and cost; we have no Spark/ML workload yet.

## Decision
Option 1. Collect into an append-only `events` table in aq-api with an allow-list of props; export daily to date-partitioned Parquet; model with dbt-duckdb; dashboard with Metabase OSS. Keep data in open Parquet so any later warehouse can load it unchanged.

Switch to **MotherDuck** when remote multi-user dashboards are needed or we move to AWS phase 2. Switch to **Snowflake** when two of: > 5 BI users, > 500 GB or > 30 s queries, client data sharing, governed access/audit needs. Choose **Databricks** only when we train or evaluate our own model at scale or need streaming/Spark.

## Consequences
- + Zero cost and zero new accounts; works on the dev Mac and the second Mac today.
- + Same layered shape (raw -> staging -> marts) as an enterprise stack, so migration is a load job plus a dbt adapter change.
- - Single-user DuckDB file; no concurrent remote BI until MotherDuck/Postgres.
- - We own the export job and its monitoring.
- Privacy rules (never keys, transcripts, notes content, raw IPs) are enforced in code by the allow-list and tested.

## Follow-ups
FU-1..FU-8 in [docs/architecture/data-platform.md](../architecture/data-platform.md#8-proposed-follow-up-cards). Step 1 shipped: `scripts/analytics/report.py`.

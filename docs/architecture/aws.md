# AQspace on AWS: reference architecture (#137)

Owner: scaling-lead. Status: proposal, no resources created. Date: 2026-11-09.

## TL;DR
- Today AQspace is one Docker host: `lecture-notes-ui` (static), `aq-api` (Node + SQLite), `lecture-notes-ai` (Python, Chromium for PDF, yt-dlp, optional Whisper, optional local Qwen3-8B per ADR-0003). Users: a handful.
- **Small (~50 users):** one region, ECS Fargate for aq-api and notes-ai, static UI on S3 + CloudFront, SQLite on EFS *or* RDS Postgres db.t4g.micro, S3 for PDFs, **Gemini API kept (no GPU)**. About **$90-140/month**.
- **Medium (~1,000 users):** same shape, more tasks, RDS Postgres Multi-AZ, SQS queue for notes jobs, WAF on. Still API models. About **$450-700/month**; +$550-750 if we self-host the model on one always-on g6.xlarge.
- **Do not** put a GPU in the cloud until API spend on notes > roughly the cost of a GPU instance (~$600/month) for two months running, or a privacy requirement forbids third-party LLMs.

## Current services to AWS mapping

```
                         Users (browser)
                               |
                     Route 53 (aqspace domain)
                               |
                 CloudFront  +  AWS WAF (managed rules, rate limit)
                 /                         \
   /*  static UI                        /api/*  (origin: ALB)
   S3 bucket (private, OAC)                  |
   lecture-notes-ui build          Application Load Balancer (HTTPS, ACM cert)
                                             |
                     +--------------- private subnets ----------------+
                     |                                                |
                     |  ECS Fargate: aq-api (Node)  0.5 vCPU / 1 GB   |
                     |    - Google OAuth (existing), sessions         |
                     |    - SQLite on EFS (small)  |  RDS Postgres (medium)
                     |    - writes analytics events (data-platform.md)|
                     |          | HTTP (service discovery)  | SQS (medium)
                     |          v                           v         |
                     |  ECS Fargate: notes-ai (Python)  2 vCPU / 4 GB |
                     |    - yt-dlp, transcripts, Chromium PDF         |
                     |    - Whisper: 4 vCPU / 8 GB task, on demand    |
                     |    - LLM: Gemini / Groq API (default)          |
                     |      or g6.xlarge + vLLM/llama.cpp (later)     |
                     +--------------------|---------------------------+
                                          |
             S3: notes PDFs + JSON (SSE-S3, lifecycle), analytics/ events (Parquet)
             Secrets Manager: GEMINI_API_KEY, GROQ_API_KEY, OAuth secret, session secret
             CloudWatch: logs (14-30 day retention), metrics, alarms -> SNS email
             AWS Backup: RDS/EFS daily snapshots, 14-35 days; S3 versioning
             NAT: one NAT gateway (small) or fck-nat instance to save ~$30
```

## Service by service

| Concern | Recommendation now | Alternatives and why not (yet) |
|---|---|---|
| UI | S3 + CloudFront (static build, cache-busted assets) | Amplify Hosting: fine, but adds a second deploy model |
| aq-api | **ECS Fargate**, 1 task small / 2-4 tasks medium behind ALB | **App Runner**: simplest, but no EFS for SQLite and AWS has put it in maintenance for new features; acceptable only once we are on RDS. **EC2**: cheapest at small size (t4g.small ~$12) but we patch the OS; good "phase 1" lift-and-shift |
| notes-ai | Fargate task 2 vCPU / 4 GB (Chromium + Python); separate "whisper" task definition 4 vCPU / 8 GB launched only when a video has no captions | Lambda: no (Chromium + long jobs, 15 min cap). Batch: good at medium if Whisper volume grows |
| Job dispatch | Small: aq-api calls notes-ai over HTTP as today. Medium: **SQS** queue + notes-ai workers scaling on queue depth | Step Functions: overkill now |
| LLM | **Keep the Gemini API** (ADR-0005), Groq fallback | Self-host Qwen3-8B on **g6.xlarge** (L4 24 GB, ~$0.80/h on-demand = ~$585/month always-on) or g5.xlarge (A10G, ~$1.01/h). SageMaker real-time endpoint adds ~15-25% markup but gives autoscaling to zero via async inference. Trigger below |
| Database | Small: SQLite on EFS with **one** aq-api task (SQLite needs a single writer) or straight to **RDS Postgres db.t4g.micro**. Medium: RDS Postgres db.t4g.medium Multi-AZ | Aurora Serverless v2: min 0.5 ACU ~$45/month, no saving at our size |
| Files | S3 bucket `aqspace-notes-<env>`: PDFs, notes JSON, checkpoints; lifecycle to Infrequent Access after 30 days | EFS for files: costlier, no CDN |
| Edge | CloudFront + WAF (AWS managed common rules + rate rule 300 req/5 min/IP on `/api/notes*`) | Shield Advanced: no |
| Auth | **Keep our Google OAuth in aq-api** (ADR-0001, sessions table) | Cognito: worth it only if we need email/password, MFA or many IdPs; migration cost is real and users would re-login |
| Secrets | Secrets Manager (~$0.40/secret/month), injected into ECS task env; IAM task roles, no keys in images | SSM Parameter Store SecureString: free tier, fine for small |
| Observability | CloudWatch Logs (JSON lines from aq-api already), Container Insights off at small, alarms on 5xx rate, notes error rate, queue age | Grafana/Datadog: later |
| Backups | AWS Backup daily for RDS/EFS (14 d small, 35 d medium), S3 versioning + 30-day noncurrent expiry, PITR on RDS | Cross-region copy: at medium, if users ask for it |
| Network | VPC with 2 AZs, public subnets for ALB only, private for tasks and RDS; security groups: ALB -> aq-api:8080, aq-api -> notes-ai:8000, aq-api -> RDS:5432 only | VPC endpoints for S3 (gateway, free) to cut NAT traffic |

### Container sizing (notes-ai)
- Chromium PDF render peaks around 500-800 MB; Python + transcript chunking ~300 MB. 2 vCPU / 4 GB is safe for 2 concurrent jobs.
- Whisper (faster-whisper small/int8 on CPU) runs ~0.3-0.5x real time on 4 vCPU; a 1 h lecture costs ~20-30 min of a 4 vCPU/8 GB task (~$0.10). Captions exist for most YouTube lectures, so this is rare.
- Local LLM on CPU is not viable in the cloud (minutes per chunk); it is GPU or API.

## Cost estimates (us-east-1, on-demand, monthly, USD)

Assumptions: list prices as of late 2026 from the AWS pricing pages (Fargate ~$0.0405/vCPU-h and ~$0.0044/GB-h for Linux/ARM-x86 blend; ALB ~$16 + LCU; NAT ~$32 + $0.045/GB; RDS db.t4g.micro ~$12, db.t4g.medium Multi-AZ ~$95; g6.xlarge ~$0.80/h; Secrets Manager $0.40/secret). Verify in the AWS Pricing Calculator before approving; numbers are rounded and exclude tax and free tier.
Usage: small = 50 users, ~300 notebooks/month, avg lecture 1 h; medium = 1,000 users, ~6,000 notebooks/month.

| Line | Small (~50 users) | Medium (~1,000 users) |
|---|---|---|
| aq-api Fargate (0.5 vCPU/1 GB x1 / x3) | $18 | $55 |
| notes-ai Fargate (2 vCPU/4 GB x1 always-on / 2-4 autoscaled) | $70 | $200 |
| Whisper on-demand tasks | $2 | $30 |
| ALB | $18 | $30 |
| NAT gateway (or fck-nat ~$4) | $33 | $45 |
| RDS Postgres (t4g.micro single-AZ / t4g.medium Multi-AZ, 20-100 GB) | $15 | $110 |
| S3 + CloudFront (PDFs, UI, <50 GB / ~500 GB egress) | $3 | $50 |
| WAF (web ACL + 2 rules + requests) | $8 | $15 |
| Secrets Manager, CloudWatch, Backup, Route 53 | $10 | $45 |
| SQS | $0 | $1 |
| **Infra subtotal** | **~$125-180** (≈$90-140 with fck-nat, SQLite on EFS, Fargate Spot for notes-ai) | **~$580** (≈$450-700 range) |
| LLM API (Gemini Flash-class, ~60k tokens in / 8k out per lecture hour) | ~$2-10 (often free tier) | ~$40-120 |
| Optional: self-hosted g6.xlarge always-on | n/a | +$585 (+$750 for g5.xlarge) |

Reading the table: at our size the **fixed** costs (NAT, ALB, always-on notes-ai) dominate, not the per-user ones. The model API is cheaper than any GPU until volume is ~10x the medium case.

Cheapest credible pilot (second Mac -> cloud): a single **EC2 t4g.medium (~$25/month) running the existing docker compose**, Caddy for TLS, S3 for backups. Use this for the first real users; move to the Fargate shape at phase 2.

## Triggers (when to change what)
| Change | Trigger |
|---|---|
| SQLite -> RDS Postgres | ADR-0002 triggers, or more than one aq-api task needed, or moving off a single host (phase 2) |
| Add SQS + autoscaled workers | p95 notes queue wait > 2 min, or > 3 concurrent jobs regularly |
| Self-host LLM on GPU | LLM API bill > $600/month for 2 consecutive months, or a client/privacy requirement, or provider quota failures > 5% of jobs after fallback |
| Cognito | Need for email/password, MFA, or SSO beyond Google |
| Multi-AZ / cross-region backup | Paying users or an availability promise |

## Phased migration plan
0. **Now (no AWS):** keep docker compose on the dev Mac; run the second Mac as a "staging" host via the tunnel for real user traffic; collect analytics per `data-platform.md`.
1. **Pilot (1 EC2, ~$30/month):** same compose file on t4g.medium in one AZ; SQLite on the EBS volume with nightly `scripts/backup-db.sh` to S3; Secrets in SSM Parameter Store; CloudFront in front. One day of work (web-dev-2).
2. **Managed containers:** images to ECR, ECS Fargate for aq-api and notes-ai, ALB, RDS Postgres (migration from SQLite by web-dev-1), PDFs to S3, Secrets Manager, CloudWatch alarms. Infra as code (Terraform or CDK) in `infra/`, owned by web-dev-2.
3. **Scale-out:** SQS for notes jobs, autoscaling on queue depth, WAF tuned, RDS Multi-AZ, AWS Backup plans, analytics events to S3 Parquet.
4. **Optional GPU:** only when the trigger fires; start with SageMaker async inference or a g6.xlarge with scheduled scale-to-zero overnight.

## Security summary
- Secrets never in images or git; ECS task role reads only its own secrets.
- Only the ALB is public; RDS and tasks in private subnets; S3 buckets block public access, CloudFront OAC for the UI only; PDFs served via short-lived presigned URLs from aq-api.
- WAF managed rules + rate limit on expensive endpoints; existing app-level rate limits stay.
- Backups: daily snapshots, PITR, S3 versioning; quarterly restore test (qa-guide checklist).
- Logs keep the dev tracker's redaction rules (no tokens, no transcripts, no raw IPs; see data-platform.md).

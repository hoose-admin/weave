# Introspection Signatures

The catalog the `introspect-codebase` op feeds to its `Explore` subagent. Each signature is a (pattern, evidence-shape, signal-type) triple — the subagent grep-walks the repo and returns matches with `file:line` evidence.

Every match MUST have evidence. A signature that finds no evidence yields no signal.

## v0.2 changelog

Three refinements driven by lessons from prior self-tests:

1. **Stripe re-categorized** from "Data layers" → new "External services" section. Stripe is a payments/billing API the codebase calls into, not a persistent store the codebase reads/writes its own data from. Downstream mapping unchanged — `subscription-tier-audit` is still the right proposal for Stripe presence.
2. **Universe / scope filter pattern tightened.** An early introspector cited a weak inline assignment (e.g. `_WHITELIST = "..."`) when the canonical constant lived in a dedicated `*/utils/`-style constants module. v0.2 prefers the canonical-constant location and treats inline lists / single-assignment constants as **weak evidence** (signal still fires but lower confidence).
3. **Cost-sensitive operations gain a concrete no-partition-filter grep pattern.** An early version mentioned partition-filter cost as a pattern but gave no actionable regex; v0.2 documents a multiline pattern for detecting `FROM \`<project>.<dataset>.<table>\`` blocks without a `WHERE ts >=` or `WHERE date >=` clause within ~10 lines.

---

## Deploy unit signatures

What counts as a deploy unit: a top-level directory that ships independently (own Dockerfile, own dependency manifest, own framework signature).

| Signal | Patterns | Evidence shape |
|---|---|---|
| **Next.js frontend** | `frontend/package.json` containing `"next":`; `next.config.{js,ts,mjs}`; `app/` or `pages/` dir | `frontend/package.json:<line>` |
| **FastAPI backend** | `*.py` containing `from fastapi import` AND `app = FastAPI(` ; `requirements.txt` containing `fastapi` | `backend/api/main.py:<line>` |
| **Cloud Run analytics container** | `Dockerfile` adjacent to a Python service; `requirements.txt` containing `google-cloud-*` | `backend/analytics/Dockerfile:<line>` |
| **Bun dashboard** | `package.json` containing `"bun":` or `"@types/bun":`; `bun.lockb` | `.weave/package.json:<line>` |
| **Static site** | `index.html` at root OR `_config.yml` (Jekyll) OR `astro.config.*` | `index.html:<line>` |
| **Python CLI/library** | `pyproject.toml` containing `[project.scripts]` or `[tool.poetry.scripts]` | `pyproject.toml:<line>` |
| **Node CLI** | `package.json` containing `"bin":` | `package.json:<line>` |
| **iOS/Android mobile** | `*.xcodeproj`, `*.gradle`, `AndroidManifest.xml` | `ios/Project.xcodeproj` |
| **Rust service** | `Cargo.toml` containing `[[bin]]` | `Cargo.toml:<line>` |
| **Go service** | `go.mod` AND `main.go` containing `func main()` | `cmd/server/main.go:<line>` |

---

## Data layer signatures

What counts as a data layer: a persistent store the codebase reads from or writes to.

| Signal | Patterns | Evidence shape |
|---|---|---|
| **BigQuery** | `from google.cloud import bigquery`; `@google-cloud/bigquery`; `bq query` in shell scripts | `backend/api/clients/bq.py:<line>` |
| **PostgreSQL (asyncpg)** | `import asyncpg`; `asyncpg.connect`; `postgresql://` URLs | `backend/api/clients/pg.py:<line>` |
| **PostgreSQL (psycopg)** | `import psycopg`; `psycopg2`; `psycopg.connect` | — |
| **PostgreSQL (SQLAlchemy)** | `from sqlalchemy`; `create_engine("postgresql://"` | — |
| **MySQL** | `import pymysql`; `mysql.connector`; `mysql://` URLs | — |
| **SQLite** | `import sqlite3`; `*.db` or `*.sqlite` files committed | — |
| **Firestore** | `from google.cloud import firestore`; `firebase-admin`; `firestore.rules` | `frontend/lib/firestore.ts:<line>` |
| **Firebase Auth** | `import firebase_admin`; `firebase/auth` in JS; `firebase.json` | `frontend/lib/firebase.ts:<line>` |
| **Redis** | `import redis`; `ioredis`; `redis://` URLs | — |
| **MongoDB** | `pymongo`; `mongoose`; `mongodb://` URLs | — |
| **Kafka** | `kafka-python`; `kafkajs`; `KAFKA_BOOTSTRAP_SERVERS` env | — |
| **Elasticsearch** | `elasticsearch-py`; `@elastic/elasticsearch` | — |
| **S3 / GCS object storage** | `boto3.client('s3')`; `from google.cloud import storage`; bucket env vars | — |

For each match, also capture: (a) read-only vs read-write usage (look for `INSERT`, `UPDATE`, `client.write_*`, `bucket.upload_*`), (b) which deploy unit imports the client.

**Not in this section** (per v0.2): **Stripe**, **Sentry**, **Datadog**, **SendGrid**, **Twilio**, and other external services that the codebase calls into but does not own data ownership of. These move to "External services" below. The downstream heuristic mapping is unaffected — `subscription-tier-audit` still fires on Stripe regardless of which section the signal lives in.

---

## External services

External APIs the codebase calls into for capability rather than for data storage. Distinct from data layers because the codebase doesn't OWN the data — it sends requests and receives responses, often with side effects on the external service. Downstream heuristics (subscription-tier-audit, observability skills, etc.) consume signals from this section the same way they consume from data layers.

| Signal | Patterns | Evidence shape |
|---|---|---|
| **Stripe (billing / payments)** | `stripe.api_key`; `@stripe/stripe-js`; `@stripe/react-stripe-js`; webhook signature constants | `frontend/package.json:<line>` |
| **Sentry (error tracking)** | `sentry_sdk.init`; `@sentry/nextjs`; `@sentry/node` | — |
| **Datadog (APM / metrics)** | `datadog`; `ddtrace`; `@datadog/browser-rum` | — |
| **SendGrid / Postmark / SES (transactional email)** | `sendgrid`; `postmark`; `boto3.client('ses')` | — |
| **Twilio (SMS / voice)** | `twilio`; `twilio.rest.Client` | — |
| **OpenAI / Anthropic / generic LLM API** | `openai`; `anthropic`; `@anthropic-ai/sdk` (skip if this skill IS the consumer — context-dependent) | — |
| **Slack (notifications)** | `slack_sdk`; `@slack/web-api`; webhook URLs | — |
| **GitHub API** | `PyGithub`; `octokit`; `gh` CLI invocations from code | — |

---

## Cross-cutting concern signatures

What counts as a cross-cutting concern: a domain that touches multiple deploy units OR doesn't map cleanly to a single one.

| Signal | Patterns | Evidence shape |
|---|---|---|
| **Authentication** | `firebase-admin` import; `verifyIdToken`; OAuth callback routes; `Authorization: Bearer`; JWT decode | `backend/api/middleware/auth.py:<line>` |
| **Subscription / billing** | `stripe.api_key`; `webhook_secret`; subscription/plan/tier columns; `customClaims` | `backend/api/routers/billing.py:<line>` |
| **Webhook handling** | `webhook` in route paths; signature verification (`hmac.compare_digest`, `stripe.Webhook.construct_event`) | — |
| **Rate limiting** | `from slowapi`; `@limiter.limit`; `RateLimiter` middleware; Cloudflare config | — |
| **CORS** | `CORSMiddleware`; `allow_origins`; `Access-Control-Allow-Origin` | — |
| **Observability — logging** | `import logging` with structured logging; `loguru`; `structlog`; `pino` | — |
| **Observability — tracing** | `opentelemetry`; `sentry_sdk.init`; `datadog`; `@sentry/nextjs` | — |
| **Observability — metrics** | `prometheus_client`; `@opentelemetry/api-metrics` | — |
| **Cost-sensitive operations** | BigQuery scans without partition filters (see "BQ no-partition-filter pattern" below); large `SELECT *`; unbounded loops over expensive APIs | — |
| **Numeric conventions** | percent-vs-decimal scale comments; `_pct` / `_percent` column suffixes; `Decimal(...)` usage in finance code | — |
| **Detector / pipeline pattern** | `detectors/`, `patterns/`, `runners/`, `*_detector.py` files; recurring `confidence`, `forward_return`, `horizon` columns | — |
| **Universe / scope filter** | a named whitelist/exclusion constant (e.g. `*_WHITELIST` / `*_EXCLUDED`) in a dedicated `*/utils/`-style module (canonical strong evidence); similar named constants elsewhere (medium evidence); hard-coded inline whitelists, single-assignment constants (weak evidence — signal still fires but lower confidence) | prefer the canonical `*/utils/<module>.py:<line>` when that location matches |

### BQ no-partition-filter pattern (v0.2, expands "Cost-sensitive operations")

When a query reads a partitioned BigQuery table without a `WHERE` clause filtering the partition column, the engine full-scans the table — for large tables (>100K rows) this is typically a P0 cost finding (high scan cost).

The introspection subagent should grep for `FROM` clauses of `<project>.<dataset>.<table>` shape (or `\`<project>.<dataset>.<table>\`` with backticks) and confirm a `WHERE` clause referencing a partition-column predicate appears within ~10 lines of the `FROM`. Common partition columns are `ts` (TIMESTAMP), `date` (DATE), `as_of_date` (DATE), or `event_ts` (TIMESTAMP).

**Multi-line regex (Python flavor, DOTALL):**

```python
FROM\s+`?\w+\.\w+\.\w+`?(?:[^;]{0,500})WHERE(?:[^;]{0,500})\b(ts|date|as_of_date|event_ts)\s*(>=|>|=|BETWEEN)
```

Match → partition-filtered (clean). **Non-match → flag as missing-partition-filter** for a downstream cost-sizing step to size + price. The introspection subagent should report the offending `file:line` of the `FROM` clause and the table name; cost projection is downstream work, not this skill's.

False-positive notes:
- A small lookup table (`<10K rows`) doesn't need a partition filter; the size check is downstream too.
- `SELECT FROM ... LIMIT 1` is sometimes safe even without a partition filter (depends on table layout) but flag anyway — let the downstream cost-sizing step decide.
- Subqueries with their own partition filter on the same table count; the regex above doesn't catch nested cases, so flag-and-let-downstream-decide is the right discipline.

---

## Deploy target signatures

| Signal | Patterns | Evidence shape |
|---|---|---|
| **GCP Cloud Run** | `gcloud run deploy`; `cloud-run-*.yaml`; `Cloud Run` in deploy docs | `Makefile:<line>` |
| **GCP Cloud Scheduler** | `gcloud scheduler`; `cloud-scheduler-*.yaml` | — |
| **AWS Lambda** | `serverless.yml`; `template.yaml` (SAM); `lambda_handler` | — |
| **AWS ECS / Fargate** | `task-definition.json`; `ecs-cli` | — |
| **Vercel** | `vercel.json`; `.vercel/` | — |
| **Netlify** | `netlify.toml`; `_redirects` | — |
| **Fly.io** | `fly.toml` | — |
| **Docker (generic)** | `Dockerfile`; `docker-compose*.yml` | — |
| **Kubernetes** | `*.yaml` with `apiVersion: apps/v1` and `kind: Deployment` | — |

---

## Subagent prompt fragment

When the `Explore` subagent is spawned, include this signature catalog inline. Instruct it to walk the repo with these patterns, return the structured report defined in `SKILL.md § introspect-codebase`, and **only return signals with file:line evidence**. No evidence → no entry.

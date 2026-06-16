---
name: security-backend
description: "Audits `backend/api/` (FastAPI) and `backend/analytics/` for server-side weaknesses against OWASP API Top 10 (2023) and OWASP ASVS: router-factory auth coverage, BOLA/BFLA, mass assignment, BQ/Postgres injection, rate-limit coverage, SSRF, CORS, Firebase token handling, custom-claim impersonation, secrets-in-logs, internal-endpoint exposure, Python dependency CVEs. Produces P0/P1/P2 punch list with [OWASP API category], CWE ID, file:line cites. Read-only; emits `pip-audit` + Bandit scripts for the user. Does NOT cover frontend (`security-frontend`), GCP infra (`security-gcp`), or per-PR diff review (`/security-review`)."
when_to_use: "User says 'audit the backend security', 'is the API locked down?', 'auth coverage on the API?', 'BQ injection check', 'BOLA check on a route', 'secrets in logs', 'analytics container security', 'OWASP API audit', 'check for SSRF', 'rate-limit coverage'."
connects_to: []
kind: audit
---

# Security Backend Audit

Read-only audit of `backend/api/` (public FastAPI) AND `backend/analytics/` (internal Cloud Run pipeline) against the OWASP API Security Top 10 (2023), OWASP ASVS v4.0, and project-specific anchors. Produces a severity-ranked punch list with file:line cites.

The body holds the procedure and output contract. The full per-category check matrix lives in `${CLAUDE_SKILL_DIR}/references/CHECK_CATALOG.md` — read it at audit time, do not paraphrase from memory.

## When to invoke

- "audit the backend security" / "full backend security audit" → `audit-all`
- "is the API locked down?" / "auth coverage on the API?" → `audit-auth`
- "BQ injection check" / "any SQL injection?" → `audit-injection`
- "BOLA check on a route" / "audit /{id} endpoints" → `audit-access-control`
- "rate-limit coverage" / "DoS posture on the API" → `audit-rate-limit`
- "check for SSRF" / "outbound URL safety" → `audit-ssrf`
- "secrets in logs" / "is anything logging tokens?" → `audit-secrets`
- "analytics container security" → `audit-analytics`
- "OWASP API audit" → `audit-all`
- "Python dep vulns" / "pip-audit" → `audit-deps` (emits script for user)

## When NOT to invoke

- **Frontend security (XSS, CSP, client-bundle leaks, Stripe webhook in Next.js)** — `security-frontend`
- **GCP infrastructure (Cloud Run ingress, IAM, VPC, Firestore rules, Secret Manager config, BigQuery dataset ACLs)** — `security-gcp`
- **Per-PR diff review** — `/security-review` (built-in; reactive, change-scoped)
- **Full system-wide composition with merged report** — the `security` orchestrator skill (orchestrates this skill + sibling subskills)
- **Cloud Scheduler hardening** — explicitly out of scope
- **Penetration testing / live exploits** — out of scope; this skill is static analysis only
- **Fixing findings** — read-only; user remediates

## Inputs

| param | default | meaning |
|---|---|---|
| `op=<name>` | `audit-all` | one of the trigger ops above |
| `container=api\|analytics\|both` | `both` | restrict to one container |
| `category=<owasp-id>` | `all` | restrict to one OWASP API category (e.g. `api1`, `api4`) |
| `severity=p0\|p1\|p2\|all` | `all` | filter output |
| `format=markdown\|json` | `markdown` | output format (JSON for orchestrator consumption) |

## Procedure

### 0. Read the check catalog

Read `${CLAUDE_SKILL_DIR}/references/CHECK_CATALOG.md`. This file owns the exact grep commands, regex patterns, file:line anchors, and per-finding severity ceilings for every check in scope. The procedure below is the WORKFLOW; the catalog is the WHAT.

Read `${CLAUDE_SKILL_DIR}/references/SUPPRESSIONS.md` to load the allowlist of known-non-findings (e.g. dev-mode `SCHEDULER_KEY` placeholder). Suppressions are applied AFTER findings are collected, never before.

### 1. Resolve scope

From the `op=` + `container=` + `category=` params, build the check-set to run:

- `audit-all` → every check across both containers
- `audit-auth` → OWASP API #2 (broken auth) categories only
- `audit-access-control` → API #1 (BOLA), #3 (BFLA), #5 (BOPLA), #9 (improper inventory)
- `audit-injection` → OWASP A03 categories (SQL, command, path, deserialization, template)
- `audit-rate-limit` → API #4 (unrestricted resource consumption)
- `audit-ssrf` → API #7 (SSRF)
- `audit-secrets` → OWASP A09 (logging) + secret hygiene
- `audit-analytics` → all checks scoped to `backend/analytics/`
- `audit-deps` → dependency CVE checks; emits `pip-audit` + `bandit` scripts

### 2. Run checks per the catalog

For each check in scope, follow the catalog's exact procedure. Always:

- Cite `file:line` for every finding (use the Grep tool with `-n` line numbers).
- Tag each finding with its OWASP category (`[OWASP API #X]` for API-Top-10, `[OWASP AZZ]` for the original Top 10) and CWE ID where available.
- Assign severity (P0/P1/P2) per the catalog's ceiling for that check.
- Do NOT exceed the catalog's severity ceiling without an explicit reason in the finding body.

### 3. Read fresh — never assume

Three pieces of state MUST be re-read on every invocation; do not cache assumptions:

- `backend/api/main.py:55-69` router list — endpoints get added/removed
- `backend/analytics/auth.py` + `main.py` + `rate_limit.py` — the analytics-container threat model has the least pinned-down state and the highest risk of drift
- `.gitignore` — verify `service-account.json` is still covered

If any anchor moved, update the catalog AS A FOLLOW-UP TICKET (do not edit the catalog inline during an audit run; it would invalidate the comparison against suppressions and prior runs).

### 4. Apply suppressions

For every collected finding, check against `references/SUPPRESSIONS.md`:

- If the finding matches a suppression pattern AND the suppression has not expired: move it to the "Suppressed" section with the suppression's reason and expiry date.
- If the suppression has expired: emit the finding at its normal severity AND a separate P2 finding "expired suppression — review or renew".
- Never silently drop a finding. Suppressed findings still appear in the output (audit trail).

### 5. Emit findings

Format per the output contract below. Order: P0 first (most urgent), then P1, then P2, then Suppressed.

### 6. Emit dependency scripts (audit-deps + audit-all)

When the dep-audit checks run, emit two shell scripts as fenced code blocks (not executed):

```bash
# Run when you want to check Python dep CVEs
pip-audit -r backend/api/requirements.txt
pip-audit -r backend/analytics/requirements.txt
```

```bash
# Run when you want a Bandit SAST sweep
bandit -r backend/ -ll -ii
```

Tell the user these are scripts to run themselves — the skill does NOT execute them (read-only invariant).

## Output format

The skill produces one markdown document per invocation. Structure:

```markdown
# Backend Security Audit — YYYY-MM-DD HH:MM

**Scope:** <op> · containers: <api | analytics | both> · category: <owasp-id | all>
**Anchors verified:** backend/api/main.py:55-69 (N routers), backend/analytics/auth.py
**Total findings:** N (P0: X, P1: Y, P2: Z, suppressed: W)

## P0 — Immediate

### [security-backend] <short-title>
- **OWASP:** API #N — <category name>
- **CWE:** CWE-NNN — <name>
- **Container:** api | analytics
- **Cite:** `backend/api/path/file.py:42`
- **Detail:** <one-line description of what's broken>
- **Suggested fix:** <one-line sketch>

## P1 — Soon
...

## P2 — Defense in depth
...

## Suppressed (N findings)
- `<finding-id>` — reason: <text>; expires: <YYYY-MM-DD>

## Dependency check scripts (run these manually)
<two fenced code blocks: pip-audit and bandit>
```

When `format=json`, emit a JSON document with the same fields, one object per finding, so the `/security` orchestrator can consume + merge + dedup.

## Container-specific notes

### `## api/` — backend/api/ (public FastAPI)

The api container is the public attack surface. Highest-priority categories:

- **API #1 BOLA** — every endpoint with `/{symbol}` / `/{uid}` / `/{id}` in the path
- **API #2 broken auth** — Firebase token verification, subscription cache
- **API #4 resource consumption** — slowapi coverage on BQ-touching routes
- **A03 injection** — BQ parameterization (e.g. via a query-param helper like `utils/bigquery.py`), Postgres path (if Cloud SQL wired)
- **A09 logging** — secret-in-logs grep

When the audit flags subscription-related findings, link any open subscription-tier / cache-coherence tickets in the output.

### `## analytics/` — backend/analytics/ (internal Cloud Run)

The analytics container is internal-only (enforced at GCP layer via Cloud Run ingress — `security-gcp`'s job to verify). Code-side audit:

- Verify `backend/analytics/auth.py` enforces a shared-secret header (SCHEDULER_KEY) or stronger; P0 if it trusts `X-Forwarded-*` for auth.
- Verify `backend/analytics/rate_limit.py` is wired into `main.py` (mirror of api's slowapi).
- Confirm code does NOT assume public reachability (no CORS-relaxed "dev mode" shipped).
- Cloud Scheduler endpoints are OUT OF SCOPE per CLAUDE.md — skip entirely.

If api ↔ analytics share any token format, verify the analytics container rejects api-issued tokens and vice versa (cross-tier replay).

## Prerequisites

- Python 3.11+ available in the user's environment (only if they run the emitted `pip-audit` / `bandit` scripts; skill itself needs nothing executable).
- The Grep / Read tools (always available in Claude Code).
- `${CLAUDE_SKILL_DIR}/references/CHECK_CATALOG.md` and `${CLAUDE_SKILL_DIR}/references/SUPPRESSIONS.md` must exist (this skill ships them).

## References

- `${CLAUDE_SKILL_DIR}/references/CHECK_CATALOG.md` — exhaustive 9-category check matrix with exact grep commands, regex patterns, file:line anchors, severity ceilings. READ THIS at audit time; do not paraphrase from memory.
- `${CLAUDE_SKILL_DIR}/references/OWASP_API_TOP_10.md` — OWASP API Security Top 10 (2023) category index with one-line summaries. Use to tag findings.
- `${CLAUDE_SKILL_DIR}/references/BANDIT_RULES.md` — Bandit rule IDs the skill grep-checks inline (B102 exec, B301 pickle, B307 eval, B502/B503 SSL, B608 SQL formatting) with the grep equivalents.
- `${CLAUDE_SKILL_DIR}/references/SUPPRESSIONS.md` — allowlist of known-non-findings (dev-mode SCHEDULER_KEY etc.) with expiry dates.
- `${CLAUDE_SKILL_DIR}/references/ASVS_INDEX.md` — OWASP ASVS v4.0 sections this skill covers (V2 auth, V3 session, V4 access control, V5 validation, V7 error handling, V8 data protection, V9 communications, V12 files, V13 API).

External (do not bundle; cite by URL in findings):
- OWASP API Security Top 10 (2023) — https://owasp.org/API-Security/editions/2023/en/0x00-header/
- OWASP ASVS v4.0 — https://owasp.org/www-project-application-security-verification-standard/
- OWASP Cheat Sheet Series — https://cheatsheetseries.owasp.org/

## After every operation

1. Suppression hygiene: if any suppression expired this run, recommend the user file a ticket to either renew or remove the suppression.
2. If new findings appeared that weren't present last run, recommend invoking the `security` orchestrator skill for full snapshot diff.
3. Re-emit the dep-audit scripts as a closing reminder — they're easy to forget, and SAST drift between runs is the #1 source of P0 surprises.

---
name: security-gcp
description: "Audits the live GCP project against CIS Google Cloud Foundation Benchmark v2.0 + Cloud Architecture Framework: IAM, Workload Identity Federation, Cloud Run ingress + per-service auth, network firewalls + VPC-SC + Cloud Armor, Cloud SQL public IP / SSL, BigQuery dataset ACLs + CMEK, Firestore rules, Secret Manager vs plaintext env, Cloud Storage public buckets + UBLA, KMS rotation, Cloud Audit Logs Data Access, Org Policy constraints, repo-vs-deployed Firestore drift. Produces P0/P1/P2 punch list with [CIS GCP X.Y] IDs and resource-path cites. Sanitizes principal emails by default. Read-only at GCP; mutations emitted as scripts. Does NOT cover frontend (`security-frontend`), backend code (`security-backend`), or cost auditing."
when_to_use: "User says 'audit GCP security', 'IAM check', 'Cloud Run ingress', 'Firestore rules audit', 'CIS benchmark check', 'workload identity audit', 'check for public buckets', 'cloud armor / DDoS'."
connects_to: []
kind: audit
---

# Security GCP Audit

Read-only audit of the live GCP project against the **CIS Google Cloud Foundation Benchmark v2.0** + **Google Cloud Architecture Framework — Security pillar**. Inspects live state via `gcloud` / `bq` / `firebase` CLIs (read-only commands ONLY). Produces a severity-ranked punch list with CIS control IDs and resource-path cites.

The body holds the procedure and output contract. The full per-category check matrix lives in `${CLAUDE_SKILL_DIR}/references/CHECK_CATALOG.md` — read it at audit time, do not paraphrase from memory.

**Critical distinction from sibling subskills:** `security-backend` and `security-frontend` are grep-only static analysis. `security-gcp` REQUIRES live `gcloud` reads. This means the skill checks `gcloud auth` state FIRST and aborts gracefully if not authenticated. It NEVER runs mutating commands (`set-iam-policy`, `update`, `delete`, `create`); only `describe` / `list` / `get-iam-policy` / `show` / `recommender list`.

## When to invoke

- "audit GCP security" / "full GCP security audit" → `audit-all`
- "IAM check" / "service account audit" → `audit-iam`
- "Cloud Run ingress" / "is analytics internal-only?" → `audit-cloudrun`
- "VPC review" / "firewall rules" / "is anything 0.0.0.0/0?" → `audit-network`
- "Cloud SQL hardening" / "is Postgres public?" → `audit-cloudsql`
- "BigQuery ACL audit" / "are datasets public?" → `audit-bigquery`
- "Firestore rules audit" / "subscriptionActive privesc check" → `audit-firestore`
- "Secret Manager usage" / "are secrets plaintext?" → `audit-secrets`
- "check for public buckets" / "Cloud Storage audit" → `audit-storage`
- "KMS audit" / "key rotation" → `audit-kms`
- "audit logs / data access" → `audit-logging`
- "org policy constraints" → `audit-orgpolicy`
- "drift between repo and deployed Firestore rules" → `audit-drift`
- "workload identity" / "SA keys" → `audit-workload-identity`
- "Cloud Armor" / "DDoS posture" → `audit-cloudarmor`

## When NOT to invoke

- **Frontend security (XSS, CSP, client-bundle leaks)** — `security-frontend`
- **Backend code (FastAPI auth, BQ injection, secrets-in-logs)** — `security-backend`
- **Per-PR diff review** — `/security-review` (built-in)
- **Full system-wide composition with merged report** — the `security` orchestrator skill (orchestrates this skill)
- **Cloud Scheduler hardening** — explicitly out of scope
- **Cost auditing** — out of scope
- **Cloud Run min/max instance right-sizing** — out of scope (this skill flags absence of max as a security gap; doesn't tune)
- **Disaster recovery / backups** — out of scope
- **Penetration testing / live exploits** — out of scope
- **Mutating GCP state** — skill is read-only at GCP

## Inputs

| param | default | meaning |
|---|---|---|
| `op=<name>` | `audit-all` | one of the trigger ops above |
| `severity=p0\|p1\|p2\|all` | `all` | filter output |
| `format=markdown\|json` | `markdown` | output format (JSON for orchestrator consumption) |
| `sanitize=true\|false` | `true` | redact principal emails in output (true) or include them (false; verbose) |
| `project=<id>` | `$(gcloud config get-value project)` | GCP project ID to audit |

## Procedure

### 0. Read the check catalog + suppressions

Read `${CLAUDE_SKILL_DIR}/references/CHECK_CATALOG.md` — owns the exact `gcloud` / `bq` / `firebase` commands, expected output shapes, severity ceilings, and CIS control IDs.

Read `${CLAUDE_SKILL_DIR}/references/SUPPRESSIONS.md` — allowlist of known-non-findings (e.g. the public API service's public ingress + `allUsers=run.invoker` is intentional; the frontend hits it as a public-facing service and app-internal bearer auth gates).

### 1. Pre-flight — verify gcloud auth

Run `gcloud auth list --filter=status:ACTIVE --format="value(account)"`. If empty: STOP and tell the user to run `gcloud auth login` first. Do NOT proceed with no-auth — the gcloud commands would each prompt or fail noisily.

Run `gcloud config get-value project`. If empty or unset: STOP and tell the user to run `gcloud config set project <PROJECT_ID>`.

Record both values for the report header.

### 2. Resolve scope

From the `op=` param, build the check-set:

- `audit-all` → every category in the catalog
- `audit-iam` → Categories 1, 2 (IAM, Workload Identity)
- `audit-cloudrun` → Category 3
- `audit-network` → Category 4 (firewalls, VPC, Cloud Armor)
- `audit-cloudsql` → Category 5
- `audit-bigquery` → Category 6
- `audit-firestore` → Category 7
- `audit-secrets` → Category 8 (Secret Manager + SA key file)
- `audit-storage` → Category 9
- `audit-kms` → Category 10
- `audit-logging` → Category 11
- `audit-orgpolicy` → Category 12
- `audit-drift` → Drift detection (repo vs deployed Firestore rules, etc.)
- `audit-workload-identity` → Category 2 only
- `audit-cloudarmor` → Category 4 subset

### 3. Run live gcloud commands per the catalog

For each check in scope, run the exact `gcloud` / `bq` command from the catalog. Parse JSON output (`--format=json` everywhere). Always:

- Cite the **resource path** (e.g. `projects/<project>/serviceAccounts/...`, `projects/<project>/buckets/<bucket>`) — NOT a file:line cite (this skill audits live state, not files).
- Tag each finding with its CIS control ID where applicable (`[CIS GCP 1.4]`), a CWE ID where relevant.
- Assign severity (P0/P1/P2) per the catalog's ceiling.
- **Sanitize principal emails by default.** When `sanitize=true` (default), replace `name@domain.com` with `<email-redacted-N>` and emit a separate redacted-mapping table at the bottom of the report. When `sanitize=false`, emit raw values — only use this when output is staying on a private screen.

### 4. Read fresh — never assume

Three pieces of state MUST be re-read on every invocation:

- `backend/firestore.rules` — repo state (compare against `firebase firestore:rules:get` for drift)
- the secret-loading entry point (e.g. an `ensure_secrets()` in `backend/api/main.py`) — to know which secrets MUST be in Secret Manager
- `.gitignore` — verify `service-account.json` still covered

### 5. Apply suppressions

For every collected finding, check against `references/SUPPRESSIONS.md`:

- If matched AND `expires` is in the future: move to "Suppressed" section.
- If matched AND `expires` is in the past: emit at normal severity + a separate P2 "expired suppression — review or renew".
- Never silently drop. Suppressed findings still appear in the report (audit trail).

### 6. Emit findings

Format per the output contract. Order: P0 first, then P1, P2, Suppressed.

### 7. Mutation-suggestion emit (NEVER execute)

For any P0/P1 finding that has a clear remediation, emit a shell script in a fenced code block that the user can copy-paste-run. Examples:

```bash
# Remove allUsers from project IAM (run only if confirmed unintentional)
gcloud projects remove-iam-policy-binding $PROJECT_ID \
  --member=allUsers \
  --role=roles/<role-name>
```

The skill itself NEVER runs these — read-only invariant.

## Output format

```markdown
# GCP Security Audit — YYYY-MM-DD HH:MM

**Project:** <project-id>
**Authenticated as:** <account>
**Scope:** <op>
**Total findings:** N (P0: X, P1: Y, P2: Z, suppressed: W)

## P0 — Immediate

### [security-gcp] <short-title>
- **CIS:** GCP X.Y — <control name>
- **CWE:** CWE-NNN — <name> (where applicable)
- **Resource:** `projects/<id>/<type>/<name>`
- **Detail:** <one-line description>
- **Suggested fix:** <shell-script in fenced block, NOT executed by skill>

## P1 — Soon
...

## P2 — Defense in depth
...

## Suppressed (N findings)
- `<finding-id>` — reason: <text>; expires: <YYYY-MM-DD>

## Redacted principal mapping (sanitize=true)
- `<email-redacted-1>` → user (full email available with `sanitize=false`)
```

When `format=json`, emit a JSON document with the same fields, one object per finding, so `/security` orchestrator can consume + merge + dedup.

## Example finding pattern — Firestore privilege escalation

If `firestore.rules` lets a client write an authorization-bearing field (e.g. a `subscriptionActive` / entitlement flag) to their own `users/{uid}` doc, AND the backend trusts that field as truth (e.g. a subscription check in `auth.py` reading the Firestore doc), that's a **privilege-escalation P0** any authenticated user can self-trigger to bypass the paywall.

When this pattern is present, surface it as P0 until `firestore.rules` is amended to either:
- Add field-level write protection (deny client writes to the entitlement field), OR
- Move that state to a server-only collection (e.g. `subscriptions/{uid}` with `allow read, write: if false`).

This is a typical cross-skill finding the `security` orchestrator dedups against `security-backend`'s subscription-cache-poisoning check.

## Prerequisites

- `gcloud` CLI installed AND authenticated (`gcloud auth login`)
- `bq` CLI installed (ships with gcloud SDK)
- `firebase` CLI installed (only if `audit-drift` for Firestore rules — emits script otherwise)
- IAM permissions on the audited project: at minimum `roles/iam.securityReviewer` OR `roles/viewer` + `roles/resourcemanager.organizationViewer` + `roles/cloudkms.viewer` + `roles/cloudsql.viewer` + `roles/securitycenter.findingsViewer`
- `${CLAUDE_SKILL_DIR}/references/CHECK_CATALOG.md` and `${CLAUDE_SKILL_DIR}/references/SUPPRESSIONS.md` must exist (this skill ships them)

## References

- `${CLAUDE_SKILL_DIR}/references/CHECK_CATALOG.md` — 12-category check matrix with exact `gcloud` / `bq` / `firebase` commands, expected output shapes, severity ceilings, CIS control IDs. READ THIS at audit time.
- `${CLAUDE_SKILL_DIR}/references/CIS_GCP_BENCHMARK.md` — CIS GCP Foundation Benchmark v2.0 control index mapped to this skill's catalog rows.
- `${CLAUDE_SKILL_DIR}/references/GCLOUD_COMMANDS.md` — canonical read-only `gcloud` / `bq` / `firebase` command reference, with output parsing hints.
- `${CLAUDE_SKILL_DIR}/references/SUPPRESSIONS.md` — allowlist of known-non-findings (intentional public services, etc.) with expiry dates.

External (do not bundle; cite by URL in findings):
- CIS Google Cloud Platform Foundation Benchmark v2.0 — https://www.cisecurity.org/benchmark/google_cloud_computing_platform
- Google Cloud Architecture Framework — Security — https://cloud.google.com/architecture/framework/security
- Cloud Run security best practices — https://cloud.google.com/run/docs/securing/overview
- IAM best practices — https://cloud.google.com/iam/docs/using-iam-securely
- Firebase Security Rules best practices — https://firebase.google.com/docs/rules/best-practices
- Secret Manager best practices — https://cloud.google.com/secret-manager/docs/best-practices

## After every operation

1. Suppression hygiene: if any suppression expired this run, recommend the user file a ticket to renew or remove.
2. If new findings appeared that weren't present last run, recommend invoking the `security` orchestrator skill for full snapshot diff.
3. If `audit-all` ran and there were P0 findings, emit a single combined remediation script the user can review and run section-by-section.
4. **NEVER execute remediation scripts. NEVER run mutating gcloud commands.** Mutation is the user's domain.

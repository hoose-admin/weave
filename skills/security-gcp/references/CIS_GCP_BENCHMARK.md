# CIS Google Cloud Foundation Benchmark v2.0 — Control Map

Maps CIS controls to this skill's `CHECK_CATALOG.md` rows. Use to verify coverage and tag findings.

Full benchmark: https://www.cisecurity.org/benchmark/google_cloud_computing_platform

## Section 1 — Identity & Access Management

| CIS | Control | Catalog row |
|---|---|---|
| 1.1 | Ensure corporate login credentials | (out — Cloud Identity admin scope) |
| 1.2 | Ensure MFA on all non-SA accounts | F.2 (informational) |
| 1.3 | Ensure SA keys NOT older than 90 days | 1.5 |
| 1.4 | Ensure no SA has admin privileges | 1.2 |
| 1.5 | Ensure IAM users NOT assigned SA user/token-creator at project level | 1.3 |
| 1.6 | Ensure user-managed/external keys for SAs are rotated every 90 days | 1.5 |
| 1.7 | Ensure separation of duties (no SA has multiple admin roles) | 10.3 |
| 1.8 | Ensure encryption keys rotation period is set | 10.1 |
| 1.9 | Ensure KMS keys NOT publicly accessible | 10.2 |
| 1.10 | Ensure KMS encryption keys rotation period | 10.1 |
| 1.11 | Ensure API keys NOT created for project | (out — no API key surface in this project) |
| 1.12 | Ensure API keys restricted to use by allowed APIs | (out — same) |
| 1.13 | Ensure API keys restricted to specified hosts/apps | (out — same) |
| 1.14 | Ensure API keys rotated every 90 days | (out — same) |
| 1.15 | Ensure Essential Contacts configured | (out — Cloud Identity admin) |
| 1.16 | Ensure Dataproc cluster encryption with CMEK | (out — not in use) |
| 1.17 | Ensure Secret Manager rotation enabled | 8.4 |

## Section 2 — Logging & Monitoring

| CIS | Control | Catalog row |
|---|---|---|
| 2.1 | Ensure Cloud Audit Logging configured properly | 6.4, 8.5, 11.1 |
| 2.2 | Ensure sinks configured for all log entries | 11.2 |
| 2.3 | Ensure retention policies on log buckets configured | 11.3 |
| 2.4 | Ensure log metric filter + alert for project ownership assignments | 11.4 |
| 2.5 | Ensure log metric filter + alert for Audit Configuration changes | 11.4 |
| 2.6 | Ensure log metric filter + alert for Custom Role changes | 11.4 |
| 2.7 | Ensure log metric filter + alert for VPC Network Firewall rule changes | 11.4 |
| 2.8 | Ensure log metric filter + alert for VPC Network route changes | 11.4 |
| 2.9 | Ensure log metric filter + alert for VPC Network changes | 11.4 |
| 2.10 | Ensure log metric filter + alert for Cloud Storage IAM permission changes | 11.4 |
| 2.11 | Ensure log metric filter + alert for SQL instance configuration changes | 11.4 |
| 2.12 | Ensure Cloud DNS logging enabled for all VPC networks | (out — informational) |

## Section 3 — Networking

| CIS | Control | Catalog row |
|---|---|---|
| 3.1 | Ensure default network does NOT exist | 4.3 |
| 3.2 | Ensure legacy networks do NOT exist | (out — legacy networks deprecated) |
| 3.3 | Ensure DNSSEC enabled for Cloud DNS | 4.4 |
| 3.4 | Ensure NOT using RSASHA1 for key-signing key | (out — granular DNSSEC) |
| 3.5 | Ensure NOT using RSASHA1 for zone-signing key | (out — same) |
| 3.6 | Ensure RDP NOT allowed from 0.0.0.0/0 | 4.1 |
| 3.7 | Ensure SSH NOT allowed from 0.0.0.0/0 | 4.1 |
| 3.8 | Ensure VPC Flow Logs enabled for every subnet | (informational P2 — add to catalog if user requests) |

## Section 4 — Compute (Cloud Run / Compute Engine)

| CIS | Control | Catalog row |
|---|---|---|
| 4.x | (Compute Engine VMs — not in use in this project; skip) | — |
| Cloud Run (not numbered in CIS yet, separate appendix) | ingress, auth, image source | 3.1–3.6 |

## Section 5 — Cloud Storage

| CIS | Control | Catalog row |
|---|---|---|
| 5.1 | Ensure buckets NOT anonymously / publicly accessible | 9.1 |
| 5.2 | Ensure Cloud Storage buckets have UBLA enabled | 9.2 |

## Section 6 — Cloud SQL Database Services (Postgres profile)

| CIS | Control | Catalog row |
|---|---|---|
| 6.1 | Ensure Cloud SQL instance NOT have any common database flags | 5.6 |
| 6.2.1 | Postgres `log_checkpoints` flag set to `on` | 5.6 |
| 6.2.2 | Postgres `log_error_verbosity` flag set | 5.6 |
| 6.2.3 | Postgres `log_connections` flag set to `on` | 5.6 |
| 6.2.4 | Postgres `log_disconnections` flag set to `on` | 5.6 |
| 6.2.5 | Postgres `log_min_messages` flag | 5.6 |
| 6.2.6 | Postgres `log_min_error_statement` flag | 5.6 |
| 6.2.7 | Postgres `log_min_duration_statement` flag | 5.6 |
| 6.3 | Ensure SSL configured for Cloud SQL | 5.3 |
| 6.4 | Ensure Cloud SQL DB instances NOT have public IPs | 5.1 |
| 6.5 | Ensure Cloud SQL DB instances configured with automated backups | 5.4 |
| 6.6 | Ensure SQL instance allowed-networks does NOT include `0.0.0.0/0` | 5.2 |
| 6.7 | Ensure SQL instance NOT open to world | 5.1 + 5.2 |

## Section 7 — BigQuery

| CIS | Control | Catalog row |
|---|---|---|
| 7.1 | Ensure BigQuery datasets NOT anonymously / publicly accessible | 6.1 |
| 7.2 | Ensure BigQuery tables encrypted by CMEK | 6.3 |
| 7.3 | Ensure tables in datasets containing PII encrypted with CMEK | 6.3 |

## Sections this skill does NOT cover

- **Compute Engine** (Section 4): this project is Cloud Run + Cloud Functions only; no VMs.
- **GKE**: not in use.
- **Dataproc**: not in use.
- **Cloud Functions**: minimal use; same posture as Cloud Run.

## Custom controls (project-specific, NOT in CIS)

| ID | Control | Catalog row |
|---|---|---|
| CUSTOM-1 | analytics service ingress=internal | 3.1 |
| CUSTOM-2 | Firestore `subscriptionActive` privesc | 7.1 |
| CUSTOM-3 | secret-loading entry point pulls from Secret Manager | 8.2 |
| CUSTOM-4 | `service-account.json` in `.gitignore` + least-privilege | 8.3 |
| CUSTOM-5 | Repo vs deployed Firestore rules drift | D.1 |
| CUSTOM-6 | `ALLOWED_ORIGINS` env var drift | D.2 |
| CUSTOM-7 | Cloud Scheduler explicitly skipped | D.3 |

## How to use this map

1. When a finding is emitted, look up the catalog row → find the CIS ID → tag as `[CIS GCP X.Y]`.
2. When the catalog adds a new check, add the row + CIS ID here (or mark CUSTOM-N if no CIS equivalent).
3. Quarterly: re-read the CIS benchmark; map any new controls back to catalog rows or skip with reason.

# GCP Security Check Catalog

A 12-category threat model. Each check is **executable** — exact `gcloud` / `bq` / `firebase` command, expected output shape, severity ceiling, CIS control ID.

**Severity ceiling** is the worst grade a finding in that bucket can earn. Exceed only with explicit justification.

**Output tag** is what the skill stamps onto the finding (`[CIS GCP X.Y]` + `[CWE-NNN]` where applicable).

All commands are READ-ONLY (`describe` / `list` / `get-iam-policy` / `show`). The skill never runs `set-iam-policy` / `update` / `create` / `delete`.

---

## Category 1 — Identity & Access Management (CIS GCP 1.x)

### 1.1 — allUsers / allAuthenticatedUsers on project IAM
- **What:** No project-level IAM binding includes `allUsers` or `allAuthenticatedUsers` on any role.
- **Command:** `gcloud projects get-iam-policy $PROJECT_ID --format=json | jq '.bindings[] | select(.members[] | test("allUsers|allAuthenticatedUsers"))'`
- **Expected output:** empty
- **Severity ceiling:** P0
- **CIS:** GCP 1.4 / 1.5
- **Tag:** `[CIS GCP 1.4 CWE-732]`

### 1.2 — Basic roles on service accounts
- **What:** No SA has `roles/owner` / `roles/editor` at project level. (Basic roles are too broad; use predefined or custom roles.)
- **Command:** `gcloud projects get-iam-policy $PROJECT_ID --format=json | jq '.bindings[] | select(.role == "roles/owner" or .role == "roles/editor") | .members[] | select(test("serviceAccount:"))'`
- **Expected output:** empty
- **Severity ceiling:** P0
- **CIS:** GCP 1.7
- **Tag:** `[CIS GCP 1.7 CWE-269]`

### 1.3 — Token-creator role broadly granted
- **What:** `roles/iam.serviceAccountTokenCreator` granted to anything other than narrowly-scoped CI/CD principals (lateral movement / impersonation risk).
- **Command:** `gcloud projects get-iam-policy $PROJECT_ID --format=json | jq '.bindings[] | select(.role == "roles/iam.serviceAccountTokenCreator")'`
- **Severity ceiling:** P0
- **CIS:** GCP 1.6
- **Tag:** `[CIS GCP 1.6 CWE-269]`

### 1.4 — Default compute SA in use by Cloud Run
- **What:** No Cloud Run service runs as the default compute SA (`PROJECT_NUMBER-compute@developer.gserviceaccount.com`).
- **Command:** `gcloud run services list --format=json | jq '.[] | {name: .metadata.name, sa: .spec.template.spec.serviceAccountName}'`
- **Expected:** every service has a non-default SA
- **Severity ceiling:** P1
- **CIS:** GCP 1.4 (related)
- **Tag:** `[CIS GCP 1.4 CWE-269]`

### 1.5 — SA key age + rotation
- **What:** No SA key older than 90 days (P1) or 365 days (P0).
- **Command:** `for sa in $(gcloud iam service-accounts list --format='value(email)'); do gcloud iam service-accounts keys list --iam-account=$sa --format=json --filter='keyType=USER_MANAGED'; done`
- **Parse:** for each key, compare `validAfterTime` against now.
- **Severity ceiling:** P1 (>90d), P0 (>365d)
- **CIS:** GCP 1.7
- **Tag:** `[CIS GCP 1.7 CWE-798]`

### 1.6 — IAM Recommender findings
- **What:** Surface over-privileged bindings the Recommender API identifies.
- **Command:** `gcloud recommender recommendations list --recommender=google.iam.policy.Recommender --location=global --project=$PROJECT_ID --format=json`
- **Severity ceiling:** P2
- **Tag:** `[CIS GCP 1.x CWE-269]`

### 1.7 — External principals
- **What:** No IAM binding includes a principal outside the known admin-domain allowlist.
- **Command:** Same as 1.1; filter `.members[]` for emails NOT matching known domains (configurable per project — pass via env or constant in skill).
- **Severity ceiling:** P1
- **Tag:** `[CIS GCP 1.x CWE-732]`

---

## Category 2 — Workload Identity & SA Key Hygiene

### 2.1 — Workload Identity Federation vs SA keys
- **What:** Production workloads (CI/CD, external services) MUST use Workload Identity Federation, NOT SA keys. SA keys are exfiltratable; WIF issues short-lived tokens.
- **Command:** `gcloud iam workload-identity-pools list --location=global --format=json` (any pools configured?) + cross-check against SA keys list (1.5).
- **Severity ceiling:** P0 (if production CI/CD uses SA keys instead of WIF)
- **CIS:** related to GCP 1.7
- **Tag:** `[CIS GCP 1.7 CWE-798]`

### 2.2 — SA key existence at all
- **What:** Minimize SA keys; prefer attached SA (Cloud Run) or WIF (external).
- **Command:** Sum of 1.5 output across all SAs. If > 1 USER_MANAGED key total in the project (excluding `service-account.json` for dev), flag.
- **Severity ceiling:** P1
- **Tag:** `[CWE-798]`

---

## Category 3 — Cloud Run (CIS GCP — Cloud Run section)

### 3.1 — analytics service ingress
- **What:** The internal analytics service MUST be `ingress: internal` OR `internal-and-cloud-load-balancing`. Never `all`.
- **Command:** `gcloud run services describe <analytics-service> --region=$REGION --format=json | jq '{ingress: .metadata.annotations["run.googleapis.com/ingress"], status: .status.url}'`
- **Severity ceiling:** P0 (if `all`)
- **CIS:** GCP — Cloud Run
- **Tag:** `[CIS GCP CWE-284]`

### 3.2 — analytics service auth
- **What:** The internal analytics service MUST NOT have an `allUsers=run.invoker` binding (internal-only services should require IAM auth).
- **Command:** `gcloud run services get-iam-policy <analytics-service> --region=$REGION --format=json`
- **Severity ceiling:** P0 (if `allUsers` is in bindings)
- **Tag:** `[CIS GCP CWE-862]`

### 3.3 — public API + frontend service ingress
- **What:** Expected `ingress: all` (public-facing). Verify intentional; document.
- **Command:** Same as 3.1 for each service.
- **Severity:** informational unless the API service is `internal` (would break the frontend) or the frontend service is anything other than `all`
- **Tag:** `[CIS GCP CWE-284]`

### 3.4 — Per-service SA
- **What:** Each Cloud Run service runs as its own SA, NOT the default compute SA. Same check as 1.4 but per-service.
- **Severity ceiling:** P1
- **Tag:** `[CIS GCP CWE-269]`

### 3.5 — Container image source
- **What:** All Cloud Run revisions pulled from this project's Artifact Registry, NOT Docker Hub / GCR-public / external registries.
- **Command:** `gcloud run revisions list --format=json | jq '.[] | {name: .metadata.name, image: .spec.containers[0].image}'`
- **Expected:** all images match `<REGION>-docker.pkg.dev/<PROJECT_ID>/...`
- **Severity ceiling:** P1
- **Tag:** `[CWE-829]`

### 3.6 — Binary Authorization
- **What:** Cloud Run revisions require signed images from trusted attestors.
- **Command:** `gcloud container binauthz policy export --format=json`
- **Severity ceiling:** P2 (best-practice; not strict requirement at this scale)
- **Tag:** `[CIS GCP CWE-829]`

### 3.7 — Max instances cap
- **What:** Every Cloud Run service has a `--max-instances` cap (runaway autoscale = bill bomb + amplifies DoS).
- **Command:** From 3.1 output, check `.spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"]` exists.
- **Severity ceiling:** P1
- **Tag:** `[CWE-770]`

### 3.8 — Cloud Run timeout
- **What:** Request timeout reasonable (≤60min default; flag if longer without justification).
- **Command:** From 3.1 output, check `.spec.template.spec.timeoutSeconds`.
- **Severity ceiling:** P2
- **Tag:** `[CWE-400]`

---

## Category 4 — Network Security (CIS GCP 3.x)

### 4.1 — Firewall rules with 0.0.0.0/0 on SSH/RDP
- **What:** No `INGRESS` rule allowing TCP/22 (SSH) or TCP/3389 (RDP) from `0.0.0.0/0`.
- **Command:** `gcloud compute firewall-rules list --format=json | jq '.[] | select((.sourceRanges // []) | contains(["0.0.0.0/0"])) | select((.allowed // [])[]?.ports // [] | contains(["22"]) or contains(["3389"]))'`
- **Severity ceiling:** P0
- **CIS:** GCP 3.6, 3.7
- **Tag:** `[CIS GCP 3.6 CWE-284]`

### 4.2 — Firewall rules with 0.0.0.0/0 on non-public services
- **What:** Other ports with `0.0.0.0/0` source — unless on intentional public load balancer.
- **Command:** Same as 4.1, broader port check.
- **Severity ceiling:** P1
- **Tag:** `[CWE-284]`

### 4.3 — Default network not in use
- **What:** No resource uses the auto-created `default` VPC.
- **Command:** `gcloud compute networks list --format=json` — flag `default` if present AND has resources attached.
- **Severity ceiling:** P1
- **CIS:** GCP 3.1
- **Tag:** `[CIS GCP 3.1]`

### 4.4 — DNSSEC on Cloud DNS
- **What:** Every public DNS zone has DNSSEC enabled.
- **Command:** `gcloud dns managed-zones list --format=json | jq '.[] | {name: .name, visibility: .visibility, dnssec: .dnssecConfig.state}'`
- **Severity ceiling:** P1 (public zones); skip private zones
- **CIS:** GCP 3.3
- **Tag:** `[CIS GCP 3.3 CWE-345]`

### 4.5 — Cloud Armor / WAF
- **What:** Public-facing services have a Cloud Armor security policy attached (DDoS, OWASP rule set).
- **Command:** `gcloud compute security-policies list --format=json`. Cross-reference against public Cloud Run services + LBs.
- **Severity ceiling:** P1 (if missing on any public service)
- **Tag:** `[CWE-770]`

### 4.6 — VPC Service Controls
- **What:** Production BigQuery / Secret Manager / Cloud Storage inside a VPC-SC perimeter (data exfil defense).
- **Command:** `gcloud access-context-manager perimeters list --policy=$POLICY_ID --format=json` (requires org-level access)
- **Severity ceiling:** P2 (best practice; complex to set up at this scale)
- **Tag:** `[CWE-200]`

### 4.7 — Private Google Access
- **What:** Cloud Run VPC connector traffic to Google APIs doesn't traverse public internet.
- **Command:** `gcloud compute networks subnets list --format=json | jq '.[] | {name: .name, pga: .privateIpGoogleAccess}'`
- **Severity ceiling:** P1 (if VPC connector in use AND PGA disabled)
- **Tag:** `[CWE-200]`

---

## Category 5 — Cloud SQL (CIS GCP 6.x — Postgres profile)

Probed first: `gcloud sql instances list --format=json`. If empty, skip this category.

### 5.1 — Public IP
- **What:** No Cloud SQL instance has a public IP.
- **Command:** `gcloud sql instances list --format=json | jq '.[] | {name: .name, public: .settings.ipConfiguration.ipv4Enabled, private_network: .settings.ipConfiguration.privateNetwork}'`
- **Expected:** `public: false`
- **Severity ceiling:** P0
- **CIS:** GCP 6.6
- **Tag:** `[CIS GCP 6.6 CWE-284]`

### 5.2 — Authorized networks
- **What:** `authorized-networks` must NOT contain `0.0.0.0/0`.
- **Command:** Same as 5.1; check `.settings.ipConfiguration.authorizedNetworks[]`.
- **Severity ceiling:** P0
- **CIS:** GCP 6.4
- **Tag:** `[CIS GCP 6.4 CWE-284]`

### 5.3 — Require SSL
- **What:** SSL required on all connections.
- **Command:** Same as 5.1; check `.settings.ipConfiguration.requireSsl`.
- **Severity ceiling:** P0
- **CIS:** GCP 6.5
- **Tag:** `[CIS GCP 6.5 CWE-319]`

### 5.4 — Automated backups
- **What:** Backups enabled.
- **Command:** Same as 5.1; check `.settings.backupConfiguration.enabled`.
- **Severity ceiling:** P1
- **CIS:** GCP 6.7
- **Tag:** `[CIS GCP 6.7]`

### 5.5 — IAM database authentication
- **What:** Password auth replaced with IAM auth.
- **Command:** Same as 5.1; check `.settings.databaseFlags[] | select(.name == "cloudsql.iam_authentication")`.
- **Severity ceiling:** P1
- **Tag:** `[CIS GCP 6.x CWE-798]`

### 5.6 — Logging database flags
- **What:** `log_checkpoints`, `log_connections`, `log_disconnections`, `log_lock_waits` enabled.
- **Command:** Same as 5.1; check `.settings.databaseFlags[]`.
- **Severity ceiling:** P1
- **CIS:** GCP 6.2.x
- **Tag:** `[CIS GCP 6.2 CWE-778]`

---

## Category 6 — BigQuery (CIS GCP 7.x)

### 6.1 — Dataset ACL with allUsers / allAuthenticatedUsers
- **What:** No dataset shared with `allUsers` or `allAuthenticatedUsers`.
- **Command:** `for ds in $(bq ls --format=json | jq -r '.[].datasetReference.datasetId'); do bq show --format=prettyjson $PROJECT_ID:$ds; done | jq '.access[] | select(.specialGroup == "allUsers" or .specialGroup == "allAuthenticatedUsers")'`
- **Expected:** empty
- **Severity ceiling:** P0
- **CIS:** GCP 7.1
- **Tag:** `[CIS GCP 7.1 CWE-732]`

### 6.2 — Per-table sharing overrides
- **What:** Per-table grants must not exceed dataset grants.
- **Command:** For each table: `bq show --format=prettyjson $PROJECT_ID:$DATASET.$TABLE` — check `.access[]` if present at table level.
- **Severity ceiling:** P0
- **Tag:** `[CIS GCP 7.x CWE-732]`

### 6.3 — CMEK on sensitive datasets
- **What:** PII / financial datasets encrypted with customer-managed keys.
- **Command:** Same as 6.1; check `.defaultEncryptionConfiguration.kmsKeyName`.
- **Severity ceiling:** P2
- **CIS:** GCP 7.2
- **Tag:** `[CWE-326]`

### 6.4 — Data Access audit logs
- **What:** Enabled for BigQuery in the project's audit config.
- **Command:** `gcloud projects get-iam-policy $PROJECT_ID --format=json | jq '.auditConfigs[]? | select(.service == "bigquery.googleapis.com")'`
- **Severity ceiling:** P1
- **CIS:** GCP 2.1
- **Tag:** `[CIS GCP 2.1 CWE-778]`

---

## Category 7 — Firestore Security Rules

### 7.1 — Client-writable authorization field (privilege-escalation pattern)
- **What:** Example pattern — if `firestore.rules` lets a client write an authorization-bearing field (e.g. a `subscriptionActive` / entitlement flag) to their own `users/{userId}` doc, AND the backend trusts that field as truth (e.g. a subscription check in `auth.py`), that's a privilege escalation.
- **Command:**
  - `Read backend/firestore.rules` — look for a rule like `allow read, write: if request.auth != null && request.auth.uid == userId` that permits writing the full doc (including any entitlement field).
  - If present and the backend trusts the field: emit P0 finding.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A01 CWE-285]`
- **Note:** This finding recurs on every run until `firestore.rules` is amended. The `security` orchestrator dedups it with `security-backend`'s subscription-cache-poisoning check.

### 7.2 — Wildcard `if true` rules
- **What:** No rule grants unconditional access.
- **Command:** `Read backend/firestore.rules`; grep for `if true` patterns.
- **Severity ceiling:** P0
- **Tag:** `[CWE-732]`

### 7.3 — Drift: repo vs deployed
- **What:** `backend/firestore.rules` matches deployed rules.
- **Command:** `firebase firestore:rules:get --project=$PROJECT_ID` then diff against repo file.
- **Severity ceiling:** P1
- **Tag:** `[CWE-732]`

### 7.4 — Firestore Rules unit tests
- **What:** Repo has Firebase Rules unit tests (`firebase emulators:exec`).
- **Command:** `ls backend/firestore.test.* backend/tests/firestore* 2>/dev/null`
- **Severity ceiling:** P2
- **Tag:** `[CIS GCP CWE-1059]`

---

## Category 8 — Secret Manager

### 8.1 — Secrets NOT in plaintext env / images
- **What:** DB passwords, third-party API keys, Stripe secrets, etc. MUST be in Secret Manager, NOT in Cloud Run env vars or container images.
- **Command:**
  - `gcloud run services describe <api-service> --region=$REGION --format=json | jq '.spec.template.spec.containers[0].env[]'`
  - Check for any plaintext-looking values (long random strings; URLs with embedded creds)
  - Cross-reference: each secret should appear via `secretKeyRef`, never as plaintext `value`
- **Severity ceiling:** P0
- **Tag:** `[CIS GCP 1.16 CWE-798]`

### 8.2 — Secret Manager source confirmation
- **What:** The secret-loading entry point (e.g. an `ensure_secrets()` in `backend/api/main.py`) pulls from Secret Manager.
- **Command:** `Read backend/api/main.py`. Confirm the import + invocation.
- **Severity ceiling:** P0
- **Tag:** `[CIS GCP 1.16]`

### 8.3 — service-account.json in repo
- **What:** `.gitignore` covers `service-account.json` AND the file (if present) is a least-privilege key, not project-owner.
- **Command:**
  - `Grep "service-account" .gitignore` — expect line `service-account.json`
  - If file exists at repo root: `gcloud iam service-accounts describe <email-from-file> --format=json` — check assigned roles
- **Severity ceiling:** P0
- **Tag:** `[CWE-540]`

### 8.4 — Secret rotation cadence
- **What:** No Secret Manager secret has had only one version for >180 days.
- **Command:** `gcloud secrets list --format=json | jq '.[].name'` then for each: `gcloud secrets versions list <secret-name> --format=json`
- **Severity ceiling:** P1
- **Tag:** `[CIS GCP 1.17]`

### 8.5 — Data Access logs on Secret Manager
- **What:** Enabled in audit config.
- **Command:** Same as 6.4 but `.service == "secretmanager.googleapis.com"`.
- **Severity ceiling:** P1
- **CIS:** GCP 2.1
- **Tag:** `[CIS GCP 2.1]`

---

## Category 9 — Cloud Storage (CIS GCP 5.x)

### 9.1 — Public buckets with non-asset content
- **What:** No bucket with `allUsers` or `allAuthenticatedUsers` containing non-asset content.
- **Command:** `gcloud storage buckets list --format=json | jq '.[].name'` then for each: `gcloud storage buckets get-iam-policy gs://<bucket> --format=json`
- **Severity ceiling:** P0
- **CIS:** GCP 5.1
- **Tag:** `[CIS GCP 5.1 CWE-732]`

### 9.2 — Uniform bucket-level access (UBLA)
- **What:** UBLA enabled (prevents object-level ACL drift).
- **Command:** `gcloud storage buckets describe gs://<bucket> --format=json | jq '.iamConfiguration.uniformBucketLevelAccess.enabled'`
- **Severity ceiling:** P1
- **CIS:** GCP 5.2
- **Tag:** `[CIS GCP 5.2]`

### 9.3 — Object versioning on production buckets
- **What:** Production / backup buckets have versioning enabled.
- **Command:** Same as 9.2; check `.versioning.enabled`.
- **Severity ceiling:** P2
- **Tag:** `[CIS GCP CWE-435]`

---

## Category 10 — Cloud KMS

Probed first: `gcloud kms keyrings list --location=$REGION --format=json`. If empty, skip.

### 10.1 — Key rotation
- **What:** No CMEK key has rotation disabled or period > 90 days.
- **Command:** For each key: `gcloud kms keys list --keyring=<ring> --location=<loc> --format=json` — check `.rotationPeriod`.
- **Severity ceiling:** P1
- **CIS:** GCP 1.10
- **Tag:** `[CIS GCP 1.10 CWE-326]`

### 10.2 — Public KMS keys
- **What:** No key has `allUsers` / `allAuthenticatedUsers`.
- **Command:** `gcloud kms keys get-iam-policy <key> --keyring=<ring> --location=<loc> --format=json`
- **Severity ceiling:** P0
- **CIS:** GCP 1.9
- **Tag:** `[CIS GCP 1.9]`

### 10.3 — Separation of duties on KMS
- **What:** Same principal does NOT have both Encrypter and Decrypter roles.
- **Command:** Same as 10.2; cross-check role bindings.
- **Severity ceiling:** P1
- **CIS:** GCP 1.8
- **Tag:** `[CIS GCP 1.8 CWE-732]`

---

## Category 11 — Audit Logging & Observability (CIS GCP 2.x)

### 11.1 — Data Access logs on critical services
- **What:** Enabled for BigQuery, Firestore, Secret Manager, Cloud Storage, Cloud SQL.
- **Command:** Same as 6.4; filter by service.
- **Severity ceiling:** P1 (if any missing)
- **CIS:** GCP 2.1
- **Tag:** `[CIS GCP 2.1]`

### 11.2 — Audit Log sink to durable destination
- **What:** Sinks export to BigQuery / Cloud Storage.
- **Command:** `gcloud logging sinks list --format=json`
- **Severity ceiling:** P1
- **CIS:** GCP 2.2
- **Tag:** `[CIS GCP 2.2]`

### 11.3 — Log bucket retention
- **What:** `_Required` retention ≥ 400 days; `_Default` ≥ 30 days.
- **Command:** `gcloud logging buckets list --location=global --format=json`
- **Severity ceiling:** P1
- **Tag:** `[CIS GCP CWE-778]`

### 11.4 — Log-based metric alerts
- **What:** Alerts on IAM policy changes, firewall changes, storage IAM changes, SQL instance config changes.
- **Command:** `gcloud logging metrics list --format=json` + `gcloud alpha monitoring policies list --format=json`
- **Severity ceiling:** P2
- **CIS:** GCP 2.4–2.11
- **Tag:** `[CIS GCP 2.4]`

---

## Category 12 — Org Policy Constraints (CIS GCP 1.x)

If user is not an org-policy admin, these probes will return empty / 403 — emit informational note in that case rather than failure.

### 12.1 — disableServiceAccountKeyCreation
- **Command:** `gcloud resource-manager org-policies describe iam.disableServiceAccountKeyCreation --project=$PROJECT_ID --format=json`
- **Expected:** `enforced: true`
- **Severity ceiling:** P1
- **CIS:** GCP 1.11
- **Tag:** `[CIS GCP 1.11]`

### 12.2 — restrictPublicIp on Cloud SQL
- **What:** If Cloud SQL in use, this constraint MUST be enforced.
- **Command:** `gcloud resource-manager org-policies describe sql.restrictPublicIp --project=$PROJECT_ID --format=json`
- **Severity ceiling:** P0 (if Cloud SQL in use and constraint not enforced)
- **Tag:** `[CIS GCP CWE-284]`

### 12.3 — allowedPolicyMemberDomains
- **What:** IAM bindings restricted to known domains.
- **Command:** `gcloud resource-manager org-policies describe iam.allowedPolicyMemberDomains --project=$PROJECT_ID --format=json`
- **Severity ceiling:** P1
- **Tag:** `[CIS GCP CWE-732]`

### 12.4 — uniformBucketLevelAccess
- **Command:** `gcloud resource-manager org-policies describe storage.uniformBucketLevelAccess --project=$PROJECT_ID --format=json`
- **Severity ceiling:** P1
- **Tag:** `[CIS GCP 5.2]`

### 12.5 — allowedIngress for Cloud Run
- **Command:** `gcloud resource-manager org-policies describe run.allowedIngress --project=$PROJECT_ID --format=json`
- **Severity ceiling:** P1
- **Tag:** `[CIS GCP CWE-284]`

---

## Drift Detection (Repo vs Deployed)

### D.1 — Firestore rules drift
- **What:** `backend/firestore.rules` matches deployed.
- **Command:** `firebase firestore:rules:get --project=$PROJECT_ID > /tmp/deployed.rules && diff backend/firestore.rules /tmp/deployed.rules`
- **Severity ceiling:** P1
- **Tag:** `[CWE-1059]`

### D.2 — Cloud Run env vars drift
- **What:** The `ALLOWED_ORIGINS` env var on the API service matches what the CORS setup in `backend/api/main.py` expects.
- **Command:** `gcloud run services describe <api-service> --region=$REGION --format=json | jq '.spec.template.spec.containers[0].env[] | select(.name == "ALLOWED_ORIGINS")'`
- **Severity ceiling:** P1
- **Tag:** `[CWE-1059]`

### D.3 — Cloud Scheduler explicitly skipped
- Cloud Scheduler is out of scope. Skill MUST skip all Cloud Scheduler probes.

---

## Firebase & Identity Platform (in-scope subset)

### F.1 — Firebase App Check
- **What:** App Check enabled (defense against scraping / non-app callers).
- **Command:** `gcloud firebase appcheck services list --format=json`
- **Severity ceiling:** P2
- **Tag:** `[CWE-862]`

### F.2 — MFA on admin accounts
- **What:** Project owners have 2-step verification (out-of-band — skill emits guidance, can't verify directly without Cloud Identity admin).
- **Action:** Emit warning + link to https://admin.google.com/security/2sv.
- **Severity ceiling:** P1 (informational — user verifies)

---

## Cross-references to sibling skills

- **Backend FastAPI auth, BQ injection, secrets-in-logs** — `security-backend`
- **Frontend XSS, CSP, client-bundle leaks** — `security-frontend`
- **Per-PR diff review** — `/security-review`
- **Composition / dedup / snapshot diff** — the `security` orchestrator skill
- **GCP mutations (write side)** — out of scope; this skill is read-only at GCP

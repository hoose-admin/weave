# Read-Only gcloud / bq / firebase Command Reference

Every command this skill is allowed to invoke. Anything not on this list is a violation of the read-only invariant.

## Allowed verbs

| CLI | Allowed verbs |
|---|---|
| `gcloud` | `describe`, `list`, `get-iam-policy`, `recommender recommendations list` |
| `bq` | `ls`, `show` |
| `firebase` | `firestore:rules:get` (read-only) |

## Forbidden verbs (NEVER run from this skill)

`set-iam-policy`, `add-iam-policy-binding`, `remove-iam-policy-binding`, `update`, `create`, `delete`, `deploy`, `replace`, `import`, `add`, `enable`, `disable`, `migrate`, `firestore:rules:release`, `secrets versions add`, ALL `bq mk` / `bq cp` / `bq load` / `bq rm` / `bq update`, all `gcloud auth` mutations (login, revoke, etc — user runs these manually).

If the skill needs to suggest a mutation, emit it as a fenced shell-script block with a comment header `# Run only if confirmed — skill does NOT execute this`. NEVER pipe to `bash` / `sh`.

## Category-by-category command reference

### Pre-flight

```bash
# Active authenticated account
gcloud auth list --filter=status:ACTIVE --format="value(account)"

# Current project
gcloud config get-value project

# Current region (some commands need it)
gcloud config get-value run/region
```

### IAM (Category 1, 2)

```bash
# Project-level IAM policy
gcloud projects get-iam-policy $PROJECT_ID --format=json

# Service accounts
gcloud iam service-accounts list --format=json

# Per-SA keys
gcloud iam service-accounts keys list --iam-account=$SA_EMAIL \
  --format=json --filter='keyType=USER_MANAGED'

# Workload Identity pools
gcloud iam workload-identity-pools list --location=global --format=json

# IAM Recommender — overly-permissive bindings
gcloud recommender recommendations list \
  --recommender=google.iam.policy.Recommender \
  --location=global --project=$PROJECT_ID --format=json
```

### Cloud Run (Category 3)

```bash
# All services in current region
gcloud run services list --format=json

# Specific service
gcloud run services describe <analytics-service> --region=$REGION --format=json
gcloud run services describe <api-service> --region=$REGION --format=json
gcloud run services describe <frontend-service> --region=$REGION --format=json

# Per-service IAM (who can invoke)
gcloud run services get-iam-policy <analytics-service> --region=$REGION --format=json

# Revisions (to check container image source)
gcloud run revisions list --format=json

# Binary Authorization policy
gcloud container binauthz policy export --format=json
```

### Network (Category 4)

```bash
# Firewall rules
gcloud compute firewall-rules list --format=json

# Networks (incl. default check)
gcloud compute networks list --format=json

# Subnets (private Google access flag)
gcloud compute networks subnets list --format=json

# Cloud DNS zones (DNSSEC check)
gcloud dns managed-zones list --format=json

# Cloud Armor policies
gcloud compute security-policies list --format=json

# VPC Service Controls (requires org-level access; may 403)
gcloud access-context-manager perimeters list --policy=$POLICY_ID --format=json
```

### Cloud SQL (Category 5)

```bash
# All instances
gcloud sql instances list --format=json

# Per-instance backups
gcloud sql backups list --instance=$INSTANCE --format=json
```

### BigQuery (Category 6)

```bash
# All datasets
bq ls --format=json

# Per-dataset ACL + config
bq show --format=prettyjson $PROJECT_ID:$DATASET_ID

# Per-table ACL (if per-table grants in use)
bq show --format=prettyjson $PROJECT_ID:$DATASET_ID.$TABLE_ID
```

### Firestore (Category 7)

```bash
# Read repo file (this skill's only "file read" — everything else is gcloud)
cat backend/firestore.rules

# Deployed rules (drift check)
firebase firestore:rules:get --project=$PROJECT_ID
# Note: firebase CLI requires user has run `firebase login` AND has been added as
# Firebase project member. If unavailable, emit script for user to run manually.
```

### Secret Manager (Category 8)

```bash
# All secrets
gcloud secrets list --format=json

# Per-secret versions
gcloud secrets versions list $SECRET_NAME --format=json

# Per-secret IAM
gcloud secrets get-iam-policy $SECRET_NAME --format=json
```

### Cloud Storage (Category 9)

```bash
# All buckets
gcloud storage buckets list --format=json

# Per-bucket IAM
gcloud storage buckets get-iam-policy gs://$BUCKET --format=json

# Per-bucket details (UBLA, versioning, etc.)
gcloud storage buckets describe gs://$BUCKET --format=json
```

### KMS (Category 10)

```bash
# All keyrings (per region)
gcloud kms keyrings list --location=$REGION --format=json

# Keys in a keyring
gcloud kms keys list --keyring=$RING --location=$REGION --format=json

# Per-key IAM
gcloud kms keys get-iam-policy $KEY --keyring=$RING --location=$REGION --format=json
```

### Logging (Category 11)

```bash
# Audit configs (in project IAM policy)
gcloud projects get-iam-policy $PROJECT_ID --format=json
# Then extract .auditConfigs[]

# Logging sinks
gcloud logging sinks list --format=json

# Log buckets (retention)
gcloud logging buckets list --location=global --format=json

# Log-based metrics
gcloud logging metrics list --format=json

# Alert policies (requires monitoring permission)
gcloud alpha monitoring policies list --format=json
```

### Org Policy (Category 12)

```bash
# Per-constraint (will 403 if user is not org admin — emit informational note)
gcloud resource-manager org-policies describe iam.disableServiceAccountKeyCreation \
  --project=$PROJECT_ID --format=json

gcloud resource-manager org-policies describe sql.restrictPublicIp \
  --project=$PROJECT_ID --format=json

gcloud resource-manager org-policies describe iam.allowedPolicyMemberDomains \
  --project=$PROJECT_ID --format=json

gcloud resource-manager org-policies describe storage.uniformBucketLevelAccess \
  --project=$PROJECT_ID --format=json

gcloud resource-manager org-policies describe run.allowedIngress \
  --project=$PROJECT_ID --format=json
```

### Firebase / Identity Platform (in-scope subset)

```bash
# Firebase App Check status
gcloud firebase appcheck services list --format=json
```

## Common output-parsing patterns

- All commands use `--format=json` so output is jq-parseable.
- For `gcloud projects get-iam-policy`, the `.bindings[]` array has `.role` + `.members[]`.
- For `gcloud sql instances list`, network config lives at `.settings.ipConfiguration`.
- For `gcloud run services describe`, ingress lives at `.metadata.annotations["run.googleapis.com/ingress"]`.
- For `bq show --format=prettyjson`, dataset ACLs live at `.access[]`.

## Permission requirements

The skill assumes the user has at minimum `roles/iam.securityReviewer` on the project. Fallback set (combine for similar coverage):
- `roles/viewer`
- `roles/resourcemanager.organizationViewer`
- `roles/cloudkms.viewer`
- `roles/cloudsql.viewer`
- `roles/securitycenter.findingsViewer`

Some checks (org policies, Cloud Identity MFA) require org-level access. If those probes return 403, the skill emits an informational note ("requires org admin — manual verification needed") rather than treating as a failure.

## What this skill does NOT do

- Run anything matching the "forbidden verbs" list above.
- Pipe gcloud output into a shell — output is always captured and parsed in Python or as JSON in markdown.
- Cache results between runs (each invocation is a fresh probe).
- Run mutating commands suggested in the report. Those are for the user.

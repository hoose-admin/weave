# Merged Output Format

Canonical schema for the orchestrator's output. Both markdown (user-facing) and JSON (snapshot persistence, future tooling consumption).

## Markdown format

```markdown
# Security Posture Report — YYYY-MM-DD HH:MM

**Project:** <project>
**Subskills run:** security-frontend, security-backend, security-gcp
**Total findings:** N (P0: X, P1: Y, P2: Z, suppressed: W)
**Diff vs last run (<ISO-date>, <N> days ago):** +A new, -B resolved, =C persistent
**Snapshot saved:** .weave/cache/security-runs/<ISO-timestamp>.json

## P0 — Immediate

### [security-backend, security-gcp] Firestore privesc on subscriptionActive
- **CWE:** CWE-285 Improper Authorization
- **OWASP:** A01 Broken Access Control
- **CVSS:** 8.8 (AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H)
- **Source 1 [security-backend]:** `backend/api/auth.py` — subscription cache reads Firestore as truth
- **Source 2 [security-gcp]:** `backend/firestore.rules` — user can write any field including `subscriptionActive`
- **Status:** PERSISTENT (3 days open, first surfaced 2026-05-20)
- **Suggested fix:** Field-level write rule denying `subscriptionActive` from the client OR move subscription state to a server-only collection (`subscriptions/{uid}` with `allow read, write: if false`).
- **Related tickets:** the subscription-cache-coherence ticket
- **Draft ticket:** see "Draft tickets" section (NEW P0s only)

### [security-frontend] Stripe webhook handler is a placeholder...
...

## P1 — Soon

### [security-frontend] No security headers configured anywhere
...

## P2 — Defense in depth

### [security-gcp] VPC Flow Logs not enabled
...

## Suppressed (N findings)

- `firebase-web-config-public` × 6 (security-frontend) — Firebase web SDK config is intentionally public per vendor docs. Expires 2026-11-22.
- `api-public-ingress` (security-gcp) — Public ingress is intentional; bearer auth at app layer. Expires 2026-11-23.
- `scheduler-key-dev-placeholder` (security-backend) — Dev-mode placeholder. Expires 2026-08-01.

## Resolved since last run (N)

- `[security-frontend] Stripe sk_test_ in client bundle` — was P0 on 2026-05-15; absent in this run. Likely fixed in TKT-XXX.

## Persistent (N findings, avg days_open: X)

| Finding | Source(s) | Severity | Days open | Related ticket |
|---|---|---|---|---|
| Firestore subscriptionActive privesc | backend, gcp | P0 | 3 | TKT-NNN |
| Missing security headers | frontend | P1 | 1 | TKT-NNN |
| ... | | | | |

## Subskill failures (if any)

- `security-gcp` — `gcloud auth` returned no active account. Run `gcloud auth login` then re-invoke.

## Draft tickets (NEW P0 findings only)

<one block per draft, formatted per references/DRAFT_TICKET_TEMPLATE.md>

User reviews each draft and files via `ticket-manager create-ticket`. The orchestrator does NOT auto-file.
```

## JSON format

The snapshot file `.weave/cache/security-runs/<ISO-timestamp>.json` has this schema:

```json
{
  "run_timestamp": "2026-05-23T00:15:00Z",
  "project": "<project>",
  "subskills_run": [
    {"name": "security-frontend", "status": "ok"},
    {"name": "security-backend", "status": "ok"},
    {"name": "security-gcp", "status": "failed", "error": "gcloud auth missing"}
  ],
  "totals": {"p0": 1, "p1": 4, "p2": 5, "suppressed": 8},
  "diff_vs": "2026-05-22T00:00:00Z",
  "diff": {"new": 0, "resolved": 1, "persistent": 9},
  "findings": [
    {
      "id": "firestore-subscriptionactive-privesc",
      "severity": "P0",
      "source_severities": {"security-backend": "P0", "security-gcp": "P0"},
      "cwe": "CWE-285",
      "owasp": "A01",
      "cvss": {"vector": "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H", "score": 8.8},
      "sources": [
        {"subskill": "security-backend", "cite": "backend/api/auth.py", "detail": "..."},
        {"subskill": "security-gcp", "cite": "backend/firestore.rules", "detail": "..."}
      ],
      "status": "PERSISTENT",
      "first_surfaced": "2026-05-20T00:00:00Z",
      "days_open": 3,
      "suggested_fix": "...",
      "related_tickets": ["TKT-NNN"]
    },
    ...
  ],
  "suppressed": [
    {
      "id": "firebase-web-config-public",
      "matched_findings": 6,
      "source": "security-frontend",
      "reason": "...",
      "expires": "2026-11-22"
    }
  ],
  "resolved_since_last_run": [
    {"id": "stripe-sk-test-in-bundle", "was_severity": "P0", "last_seen": "2026-05-15T00:00:00Z"}
  ],
  "draft_tickets": [
    {"finding_id": "...", "body": "<markdown ticket template>"}
  ]
}
```

## Finding shape (canonical)

Every finding object MUST have:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable identifier — derivation rule below. Used for dedup + diff. |
| `severity` | `P0` / `P1` / `P2` | CVSS-anchored normalized severity (per `CVSS_SCORING.md`). |
| `source_severities` | map | Per-subskill self-rating. Surfaces calibration mismatches. |
| `cwe` | string | `CWE-NNN` if assignable. |
| `owasp` | string | `API #N` (2023) / `A0N` (2021) / `CIS GCP X.Y`. |
| `cvss` | object | `{vector, score}` if known; otherwise omit. |
| `sources` | array | One entry per subskill that surfaced this finding. Each has `subskill`, `cite`, `detail`. |
| `status` | `NEW` / `PERSISTENT` / `RESOLVED` | Set by the snapshot-diff step. |
| `first_surfaced` | ISO date | When this finding first appeared across runs. |
| `days_open` | int | `now - first_surfaced` in days. |
| `suggested_fix` | string | Synthesis of subskill fix sketches. |
| `related_tickets` | array of TKT-NNN | Cross-references. Populated by the open-ticket lookup step (SKILL.md procedure 2.5). |
| `has_open_ticket` | bool | Convenience: `related_tickets.length > 0 AND any of them is in 0-backlog/1-staging/2-stuck/3-building/4-testing/5-validating`. Drives auto-draft skip in step 3e. |

## Stable id derivation

`id = "<cwe-lower>-<resource-slug>"` where:
- `cwe-lower` = `"cwe-285"` (the digits, lowercased)
- `resource-slug` = the **normalized resource** with `/`, `.`, `,`, `:`, `_` → `-`, lowercased, with leading `backend-` / `frontend-` stripped (matches the dedup normalization in SKILL.md step 3b)

Examples:
- `auth.py:106-156` (security-backend) → normalized `auth.py` → slug `auth-py` → id `cwe-285-auth-py`
- `backend/firestore.rules:5` (security-gcp) → normalized `firestore.rules` → slug `firestore-rules` → id `cwe-285-firestore-rules`

Both findings have CWE-285. But their resource slugs differ — so they'd NOT auto-dedup by id alone. The dedup step uses the `(cwe, normalized_resource)` pair AND also checks for "logically same issue across different files" — for the Firestore privesc case, the orchestrator hardcodes the cross-file-pair as a known merge (documented in `suppressions.yaml`'s `cross-skill-api-public-by-design` precedent and in the worked example in SKILL.md step 3b).

**Limitation:** if a file is renamed or moved, the id changes and the finding flips NEW in the next snapshot. This is a known weakness. Mitigate by:
- Keeping the `suggested_fix` text stable across renames (so a reader recognizes the finding)
- When a real rename happens, the user manually merges the old/new snapshot entries OR accepts one cycle of NEW/RESOLVED churn

## Subskill output contract (v1: markdown parsing)

Today the orchestrator parses each subskill's markdown output (passed `format=markdown` by default — the subskills' JSON mode is documented but not yet implemented in their bodies).

Markdown contract per subskill:
- Sections delimited by `## P0 — Immediate`, `## P1 — Soon`, `## P2 — Defense in depth`, `## Suppressed (N findings)`, `## Clean (...)`.
- Each finding: `### [<subskill-name>] <title>` block followed by bulleted metadata with keys: `CWE:`, `OWASP:`, `Container:` (security-backend) | `Cite:` (security-frontend/backend) | `Resource:` (security-gcp), `Detail:`, `Suggested fix:`.
- Optional keys: `Status:`, `CVSS:`, `Related tickets:`.
- Each subskill MAY add domain-specific keys; orchestrator ignores unknowns.

The orchestrator's parser handles missing keys gracefully (default to empty string).

JSON output is a future enhancement. When it lands, this section gets a JSON schema per subskill instead of a markdown contract.

## Snapshot retention

- Snapshots in `.weave/cache/security-runs/` accumulate over time.
- The skill **auto-prunes** to keep the latest 30 snapshots after each new write. Older snapshots are deleted (oldest first by ISO timestamp).
- `diff` op uses the most-recent prior snapshot by default; `since=<ISO-date>` selects an earlier snapshot (if still retained).
- Snapshots have NO PII beyond resource paths and CWE IDs (principal emails are pre-redacted by `security-gcp` per its `sanitize=true` default).
- Snapshot file size: roughly 5-20 KB per run depending on finding count. 30 snapshots × ~15 KB = ~450 KB total — small.

## Snapshot retention

- Snapshots in `.weave/cache/security-runs/` accumulate over time.
- After 30 snapshots, the skill suggests pruning (does not auto-prune).
- `diff` op uses the most-recent prior snapshot by default; `since=<ISO-date>` selects an earlier one.
- Snapshots have NO PII beyond resource paths and CWE IDs (principal emails are pre-redacted by `security-gcp` per its sanitize=true default).

## What this file does NOT specify

- Subskill JSON output schema (when implemented) — each subskill will define its own. The orchestrator's parser becomes per-subskill (1 file per subskill in `references/parsers/` if/when the orchestrator gets fancier).
- Markdown rendering details (header styling, etc.) — Claude renders in its own style; structure matters more than typography.
- Tooling that reads these snapshots — none today. The format is future-proofed for a `.weave/` dashboard view if/when added.

## Snapshot file format (`.weave/cache/security-runs/<ISO>.json`)

The on-disk snapshot is the JSON document shown above, written verbatim. Filename = `YYYY-MM-DDTHH-MM-SSZ.json` (ISO 8601 with `-` instead of `:` for filesystem safety).

Schema versioning: top-level `schema_version: "1.0"` field. If/when the schema breaks compatibility, bump the version and add a migration note here.

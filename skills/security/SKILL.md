---
name: security
description: "Orchestrates the security audit family. Routes to `security-frontend`, `security-backend`, and `security-gcp`, then composes findings into one merged report: CVSS-anchored severity, cross-skill deduplication via (CWE, normalized-resource) key, open-ticket lookup (links to existing TKT-NNN), snapshot diff vs prior run (NEW / RESOLVED / PERSISTENT with days-open), suppression rules with mandatory expiry, auto-draft for NEW P0s without a related ticket. System-wide proactive; coexists with `/security-review` (per-PR reactive). Does NOT execute fixes. Read-only."
when_to_use: "User says 'audit security', 'full security review', 'is the system locked down?', 'what's our security posture?', 'security posture diff', 'what's new since last audit?', 'plan a security audit' (dry-run), 'auth coverage' (backend+gcp), 'DDoS posture' (backend+gcp), 'data exfil risk' (all three), 'draft tickets for the P0s'."
connects_to:
  - parent:security-frontend
  - parent:security-backend
  - parent:security-gcp
  - handoff:ticket-manager
kind: orchestrator
---

# Security

Security family entry point.

Routes security-audit intents to one or more of three subskills (`security-frontend`, `security-backend`, `security-gcp`), then composes their outputs into a single coherent posture report. **This skill never audits directly** — every check is delegated.

Body holds routing + composition; detail lives in `${CLAUDE_SKILL_DIR}/references/`.

## When to invoke

- "audit security" / "full security review" → `op=full-sweep`
- "is the system locked down?" / "what's our security posture?" → `op=full-sweep`
- "plan a security audit" / "what would full-sweep run?" → `op=plan` (dry-run; no subskill invocation)
- "what's new since last audit?" / "security posture diff" → `op=diff` (re-runs subskills; emits only NEW/RESOLVED sections)
- "is the API locked down?" / "auth coverage on the API?" → routes to `security-backend` only
- "any XSS in the frontend?" / "is the bundle leaking keys?" → routes to `security-frontend` only
- "are our GCP settings correct?" / "VPC audit" / "IAM review" / "Firestore rules" → routes to `security-gcp` only
- "auth coverage" → fans out to `security-backend` + `security-gcp` (merges + dedups)
- "DDoS posture" → `security-backend` + `security-gcp`
- "data exfil risk" → all 3
- "draft tickets for the P0s" → `op=draft-tickets` (uses last snapshot; doesn't re-run subskills)

## When NOT to invoke

- **Per-PR diff review** — `/security-review` (built-in, reactive, change-scoped). Don't run both back-to-back expecting non-overlapping output.
- **One subskill explicitly named** — invoke that subskill directly; this orchestrator is for multi-skill / routing-ambiguous intents.
- **Pen testing / live exploits** — out of scope; all subskills are static + read-only.
- **Fix execution** — produces the merged report; user remediates.
- **Cloud Scheduler hardening** — all three subskills explicitly skip Scheduler.
- **Cost / right-sizing / DR** — out of scope here.

## Inputs

| param | default | meaning |
|---|---|---|
| `op=<name>` | `full-sweep` | `full-sweep`, `plan`, `diff`, `draft-tickets`, or a single subskill name |
| `subskills=<list>` | (inferred from intent) | comma-separated subset for fan-out ops |
| `severity=p0\|p1\|p2\|all` | `all` | filter merged output |
| `format=markdown\|json` | `markdown` | output format |
| `since=<ISO-date>` | last snapshot | for `diff` op — compare against snapshot from a specific date |
| `drafts_to=inline\|scratch` | `inline` | where to emit draft tickets: inline in the report, or as files in `.tickets/scratch/` (dashboard's quick-create surface) |

## Procedure

### 0. Read references

Read in order: `${CLAUDE_SKILL_DIR}/references/CVSS_SCORING.md`, `${CLAUDE_SKILL_DIR}/references/MERGED_OUTPUT_FORMAT.md`, `${CLAUDE_SKILL_DIR}/suppressions.yaml`. Read `${CLAUDE_SKILL_DIR}/references/DRAFT_TICKET_TEMPLATE.md` only if `op` will emit drafts.

### 1. Resolve scope from intent

From `op=` + intent keywords:

- `plan` → emit the resolved scope + planned subskill invocations + cached-snapshot context, then STOP. No subskill execution.
- `full-sweep` / multi-skill fan-out → list the subskills to invoke
- single-subskill name → just that one
- `diff` → same scope as last snapshot's run (so apples-to-apples)
- `draft-tickets` → DO NOT re-run subskills; load last snapshot from `.weave/cache/security-runs/` and emit drafts from its findings

### 2. Run subskills (Skill tool calls)

For each subskill in scope, make a `Skill` tool call with `args=<subskill-op>` per the per-subskill defaults:

- `security-frontend` → `op=audit-all`
- `security-backend` → `op=audit-all container=both`
- `security-gcp` → `op=audit-all`

**Parallelism:** when invoking 2+ subskills, place all `Skill` calls in a single message so they run in parallel. (Single message, multiple tool-use blocks.)

**Output handling:** each subskill returns its full markdown report as the response. Parse by:
- Splitting on `## P0`, `## P1`, `## P2`, `## Suppressed`, `## Clean` headings
- Extracting per-finding blocks (`### [security-X] <title>` then bulleted metadata)
- Reading `CWE`, `OWASP`, `Cite`/`Resource`, `Detail`, `Suggested fix`, `Status` (if present) from each block

**Subskill output contract.** Today each subskill emits markdown matching its own SKILL.md "Output format" section. `format=json` is documented in the subskill bodies but the JSON schema is not yet pinned — for v1, the orchestrator passes `format=markdown` (the default) and parses markdown. JSON-output mode is a future enhancement.

**Subskill failure:** if a subskill fails (e.g. `security-gcp` aborts on missing `gcloud auth`), record `{subskill, status: "failed", error_text}` and continue with the others. Never abort the merge.

### 2.5. Open-ticket cross-reference scan

BEFORE composition, build an open-ticket map so the orchestrator can link findings to existing tickets instead of drafting duplicates.

- Glob `.tickets/{0-backlog,1-staging,2-stuck,3-building,4-testing,5-validating}/TKT-*.md` (NOT `6-complete` or `7-archive` — those are closed work).
- For each ticket, parse frontmatter: read `tags`. If `tags` contains `security`, extract `id` (TKT-NNN) and the ticket title.
- Read the ticket body's `### Context` section; grep for `CWE-NNN` mentions and file paths cited.
- Build a map: `{(cwe, normalized_resource_glob)} → TKT-NNN`.

When a finding's `(cwe, normalized_resource)` matches an open-ticket entry, stamp the finding with `related_tickets: [TKT-NNN]` and skip auto-draft in step 3e.

### 3. Composition — five responsibilities, applied in order

**3a. Scoring normalization (CVSS-anchored).** Look up each finding's self-rated P0/P1/P2 in `references/CVSS_SCORING.md`. If subskill supplied a `cvss` vector (rare today), preserve. Never fabricate. If two subskills disagree post-dedup, take the higher severity and emit an informational note ("subskill calibration mismatch on `<id>`").

**3b. Deduplication.** Findings sharing `(cwe, normalized_resource)` collapse to ONE entry with multiple `[source]` tags. Worked example: backend flags `auth.py` trusts Firestore as truth; gcp flags `firestore.rules` lets clients write the same field. Both CWE-285. Merge to one entry `[security-backend, security-gcp]`. **Normalized resource** = strip line ranges (`auth.py:106-156` → `auth.py`), strip leading `backend/` or `frontend/` prefix, lowercase. Never collapse across distinct CWE IDs.

**3c. Suppression.** Apply `suppressions.yaml` post-dedup:
- Match + future expiry → "Suppressed" section
- Match + past expiry → emit at normal severity + separate P2 "expired suppression — review or renew"
- No match → emit at normal severity
- Never silently drop

**3d. Snapshot diff.** Load most-recent prior snapshot from `.weave/cache/security-runs/<latest>.json` (use `since=<ISO-date>` param if provided). For each finding (post-dedup, post-suppression):
- Present this run AND last run, same `id` → `PERSISTENT` with `days_open = now - first_surfaced` (carry `first_surfaced` forward across snapshots)
- Present this run, absent last run → `NEW` (`first_surfaced = now`)
- Absent this run, present last run → `RESOLVED` (lift entry from last snapshot for the report; remove from this snapshot)

**Stable finding `id` derivation:** `id = "<cwe-lower>-<resource-slug>"` where `resource-slug` is the normalized resource with `/.,:_` → `-` and lowercased. Example: `cwe-285-backend-firestore.rules`. **Limitation:** if a file is renamed or moved, the id changes and the finding flips NEW. Document as known limitation; mitigate by keeping fix sketches stable (so a renamed-file finding is recognizably the same finding to a reader).

If no prior snapshot exists: emit baseline (no diff section).

**3e. Auto-draft tickets.** For every NEW P0 finding WITHOUT a matching open ticket (per step 2.5 map):
- Emit a draft ticket body per `references/DRAFT_TICKET_TEMPLATE.md`
- If `drafts_to=inline` (default): include in "Draft tickets" report section
- If `drafts_to=scratch`: write to `.tickets/scratch/draft-security-<finding-id>-<ISO-date>.md` and emit the path in the report

NEW P0 findings WITH a matching open ticket get a "Related ticket: TKT-NNN" line in the main finding entry and are NOT drafted. This prevents duplicate-ticket spam from already-known issues.

### 4. Persist snapshot

Write findings to `.weave/cache/security-runs/<ISO-timestamp>.json`. Schema in `references/MERGED_OUTPUT_FORMAT.md`.

**Auto-prune:** after writing the new snapshot, if more than 30 snapshots exist, delete the oldest ones until 30 remain. (Updates the "only write" claim: writes are 1 snapshot create + N old-snapshot deletes, all confined to `.weave/cache/security-runs/`.)

### 5. Emit report

Format per `references/MERGED_OUTPUT_FORMAT.md`. Order: header (summary + diff) → P0 → P1 → P2 → Suppressed → Resolved → Persistent → Subskill failures (if any) → Draft tickets (if any).

### 6. Always-run wrap-up

- **Suppression hygiene:** expired suppressions → surface prominently.
- **Subskill failure recap:** if any subskill failed, list which + the one-line fix (e.g. `gcloud auth login`).
- **Diff teaser:** if `op=full-sweep`, suggest re-running tomorrow with `op=diff` to see what changed.
- **Schedule suggestion:** if more than 14 days since last full-sweep, suggest configuring a recurring run via `/schedule` or `/loop`.

## Subskill output contract (v1: markdown)

For v1, the orchestrator parses each subskill's markdown output. The contract:

1. Subskill emits sections with `## P0 — Immediate`, `## P1 — Soon`, `## P2 — Defense in depth`, `## Suppressed`, `## Clean (no findings)`.
2. Each finding is a `### [<subskill-name>] <title>` block followed by a bulleted list with keys `CWE:`, `OWASP:`, `Container:` or `Cite:` or `Resource:`, `Detail:`, `Suggested fix:`.
3. Each subskill MAY add domain-specific keys (e.g. security-gcp adds `Resource:`; security-frontend/backend use `Cite:`).
4. Orchestrator handles missing keys gracefully (default to empty string).

When subskills add JSON output (future), this contract switches to JSON schema parsing and the orchestrator passes `format=json` instead. Until then, markdown parsing is canonical.

## Suppression scope

Two layers, both honored:

1. **Subskill-local** — each subskill's `references/SUPPRESSIONS.md` handles intra-skill known-non-findings (Firebase web config in security-frontend, scheduler-key in security-backend, public Cloud Run ingress in security-gcp). Applied by the subskill itself BEFORE its output reaches the orchestrator.
2. **Orchestrator-wide** — `${CLAUDE_SKILL_DIR}/suppressions.yaml` handles cross-skill duplicates the subskills can't see (e.g., a multi-source finding that's architecturally intentional at the system level).

If a suppression could be local (single subskill scope), put it in the subskill's file. If it spans 2+ subskills, put it here. The orchestrator's suppression scan runs AFTER dedup, so a cross-skill suppression matches the merged entry, not the individual sources.

## Output format

See `references/MERGED_OUTPUT_FORMAT.md` for the full markdown + JSON schema. Top-level sections in order:

1. Header (project, subskills run, totals, diff summary, snapshot path)
2. `## P0 — Immediate` — one block per merged finding
3. `## P1 — Soon`
4. `## P2 — Defense in depth`
5. `## Suppressed (N)` — per-suppression breakdown
6. `## Resolved since last run (N)` — lifted from last snapshot
7. `## Persistent (N findings, avg days_open: X)` — table form
8. `## Subskill failures` — only if any
9. `## Draft tickets (M NEW P0 findings)` — only if any NEW P0 lacks an open ticket

JSON mode emits the same fields as one document with top-level `findings`, `suppressed`, `resolved_since_last_run`, `draft_tickets` arrays plus `subskills_run` + `diff` metadata.

## Coexistence with /security-review

- `/security-review` (built-in) — **reactive, per-PR.** Reviews `git diff` on current branch. Scoped to changed lines.
- `/security` (this skill) + 3 subskills — **proactive, system-wide.** Audits accumulated drift across the full architecture.

Both coexist; don't run them back-to-back expecting non-overlapping output. For "diff since last system audit," use `op=diff` here.

## Prerequisites

- `security-frontend`, `security-backend`, `security-gcp` skills installed (this skill aborts gracefully if any are missing — emit which + the path to scaffold them).
- `.weave/cache/` exists (the dashboard creates it; this skill creates `security-runs/` lazily).
- `${CLAUDE_SKILL_DIR}/references/{CVSS_SCORING,MERGED_OUTPUT_FORMAT,DRAFT_TICKET_TEMPLATE}.md` + `suppressions.yaml` ship with this skill.

## References

- `${CLAUDE_SKILL_DIR}/references/CVSS_SCORING.md` — score band → severity mapping.
- `${CLAUDE_SKILL_DIR}/references/MERGED_OUTPUT_FORMAT.md` — exact merged-report schema (markdown + JSON), finding shape, stable-id rule, snapshot file format.
- `${CLAUDE_SKILL_DIR}/references/DRAFT_TICKET_TEMPLATE.md` — auto-drafted ticket body template. Mirrors `ticket-manager/templates/ticket-template.md`.
- `${CLAUDE_SKILL_DIR}/suppressions.yaml` — orchestrator-wide cross-skill allowlist.

External:
- CVSS v3.1 — https://www.first.org/cvss/v3-1/specification-document
- CWE Top 25 (2023) — https://cwe.mitre.org/top25/archive/2023/2023_top25_list.html

In-repo:
- `.claude/skills/ticket-manager/templates/ticket-template.md` — base template for draft conformance.

## After every operation

1. **Suppression hygiene:** expired suppressions → surface prominently.
2. **Cache hygiene:** auto-prune kept `.weave/cache/security-runs/` at ≤30 snapshots; mention how many were pruned this run.
3. **Subskill auth recap:** if `security-gcp` failed for `gcloud auth`, the one-line fix.
4. **Open-ticket alignment:** if any NEW P0 lacked a matching open ticket (and was auto-drafted), recommend filing via `ticket-manager create-ticket` or via the dashboard's scratch-pad quick-create.
5. **Read-only invariant:** writes are confined to `.weave/cache/security-runs/` (snapshot + auto-prune deletes) AND optionally `.tickets/scratch/` (only if `drafts_to=scratch`). NEVER mutate GCP, NEVER auto-file tickets to `0-backlog`, NEVER edit source code.

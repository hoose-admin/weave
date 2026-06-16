# Draft Ticket Template

For every NEW P0 finding (per the snapshot diff), the orchestrator emits a draft ticket body matching this template. The user reviews and files via `ticket-manager create-ticket` — the orchestrator does NOT auto-file.

## Why draft, not auto-file

- The same finding might surface across multiple runs before the user has time to file (flapping noise → auto-file would create duplicate tickets).
- Some "NEW" findings are noise (calibration drift, new check just added) — user judgment is required.
- Ticket-manager has its own ID-assignment + linking semantics; auto-invocation bypasses its dedup logic.

## Template

```markdown
---
id: TKT-XXX  # ticket-manager assigns next available
title: "<severity-tag> <one-line finding title>"
status: "Todo"
priority: "High"  # P0 finding → priority: High
assignee: "Claude-Agent"  # or "User" if requires human judgment
created: <today's date>
domain: <app | infra | docs | meta>  # from subskill source
tags:
  - security
  - bug
  - <other category from finding>
depends_on: []
blocks: []
related: [<any tickets this finding cross-references>]
files_touched: []
---

### Objective

<One-paragraph description of the finding. Lead with the user-visible risk, then the technical surface. E.g.: "An authenticated user can write `subscriptionActive: true` to their own Firestore user doc, bypassing the API's subscription check in `auth.py` and accessing premium features without paying. Tightening this requires either field-level write rules or moving subscription state to a server-only collection.">

### Context

Surfaced by `/security` on <date> — see merged report.

**Source 1 — [<subskill 1>]:** `<cite>` — <detail>
**Source 2 — [<subskill 2>]:** `<cite>` — <detail>
(if dedup'd across subskills)

**CWE:** CWE-NNN — <name>
**OWASP:** <category>
**CVSS:** <vector + score, if known>

**Persistence:** First surfaced <first_surfaced date> (N days open).

**Cross-references:**
- Related ticket: TKT-NNN
- Memory: <relevant memory entry>
- ADR: <relevant ADR>

### Acceptance Criteria

- [ ] <Specific, testable check 1 — usually "the fix sketch above"
- [ ] Re-run `/security` — finding is RESOLVED in next snapshot diff.
- [ ] If fix introduces user-visible behavior change, document in CHANGELOG or release notes.
- [ ] If fix requires a data backfill (e.g. existing users with self-elevated `subscriptionActive`), file a separate remediation ticket.

### Out of Scope

- <Adjacent issues this ticket explicitly does NOT solve>
- <Other findings from the same audit run that are separate work>

### Notes

- Auto-drafted by `/security` orchestrator. Review the finding's source cites + suggested-fix before accepting the framing — orchestrator output is starting material, not final spec.
- If the finding is actually a false positive, add a suppression to the appropriate file:
  - Cross-skill: `.claude/skills/security/suppressions.yaml`
  - Subskill-specific: `.claude/skills/<subskill>/references/SUPPRESSIONS.md`

### Implementation Summary
<!-- Populated automatically by the ticket-manager skill when this ticket moves to 4-testing.
     Do not fill in manually before implementation is complete. -->
<Empty until the ticket reaches 4-testing.>
```

## How to populate

For each NEW P0 finding:

1. **Title:** `[<source-subskills>] <short-title from finding>` — example: `[security-backend, security-gcp] Firestore privesc on subscriptionActive`.
2. **Domain:** map from primary source subskill:
   - `security-frontend` → `app`
   - `security-backend` → `app` (or `infra` if infra/deploy scoped)
   - `security-gcp` → `infra`
   - Multi-source → use whichever subskill has the source closer to the fix surface.
3. **Tags:** always `security`, plus `bug` for P0 findings, plus a domain tag (`frontend`, `backend`, `gcp`).
4. **Related:** include any tickets the finding cross-references.
5. **CVSS / CWE / OWASP:** copy verbatim from the orchestrator's merged finding.
6. **Suggested fix → Acceptance Criteria:** convert the orchestrator's one-line fix sketch into bullet-form testable checks.

## What the orchestrator does NOT do

- Compute next ticket ID (ticket-manager owns that).
- Set `depends_on` / `blocks` (the orchestrator can guess `related:` but ordering is a human call).
- Write to `.tickets/0-backlog/` — user files via `ticket-manager create-ticket`.

## Future enhancement (not built today)

If/when the `.weave/` dashboard adds a "promote draft to ticket" UI, the orchestrator could write draft files to `.tickets/scratch/` instead of inlining in the report. For now, inline emit is simpler and keeps the user in control.

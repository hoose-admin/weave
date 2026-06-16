# Suppressions — Known-Non-Findings

Findings that match a pattern below are MOVED to the report's "Suppressed" section (not silently dropped — audit trail preserved). Suppressions MUST have an expiry date so they get re-reviewed.

Format (informal — YAML-like, parsed by the skill at audit time):

```
- id: <stable-identifier>
  pattern: <how to match>
  reason: <why intentional>
  expires: YYYY-MM-DD
  source: <link to memory / ADR / ticket>
```

---

## Active suppressions

```
- id: scheduler-key-dev-placeholder
  pattern:
    container: analytics
    file: backend/analytics/auth.py
    finding_type: weak-shared-secret
    token: SCHEDULER_KEY
  reason: |
    Dev-mode SCHEDULER_KEY placeholder is intentional. Production injects
    the real value via Secret Manager at deploy time; the placeholder is
    a dev convenience so local backfill endpoints work without secret
    config.
  expires: 2026-08-01
  source: project convention (dev-only placeholder)
```

---

## How the skill applies suppressions

1. Run all checks per `CHECK_CATALOG.md`, collect findings.
2. For each finding, scan this file for a matching pattern.
3. If matched AND `expires` is in the future: move to "Suppressed" section.
4. If matched AND `expires` is in the past:
   - Emit the finding at its normal severity (DO NOT suppress)
   - ALSO emit a separate P2 finding: `expired suppression <id> — review or renew`
5. If no match: emit at normal severity.

## Adding a new suppression

A new suppression MUST come with:

1. **Stable id** (kebab-case, descriptive)
2. **Pattern** specific enough to not collapse unrelated findings (include `container` + `file` at minimum)
3. **Reason** that links to a durable source (memory / ADR / ticket — not "Bx said so in chat")
4. **Expiry** ≤ 6 months from creation. Renew explicitly if still valid then.

Never use suppressions as a way to silence a finding you don't want to fix. The expiry forces a periodic re-evaluation; suppressions without expiries become tech debt.

## Empty-state behavior

If this file has zero active suppressions, the skill emits the "Suppressed (0 findings)" header anyway so the user can see at a glance that nothing is hidden.

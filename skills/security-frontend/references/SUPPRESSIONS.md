# Suppressions — Known-Non-Findings (Frontend)

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
- id: firebase-web-config-public
  pattern:
    finding_type: client-bundle-leak
    keys: [apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId, measurementId]
    file_glob: frontend/lib/firebase.ts
  reason: |
    Firebase Web SDK config (apiKey, authDomain, projectId, etc.) is
    intentionally exposed in the client bundle by design. The security
    boundary is enforced at Firebase Security Rules + Identity Platform,
    not at key secrecy. Per https://firebase.google.com/docs/projects/api-keys,
    these are not secrets.
  expires: 2026-11-22
  source: Firebase docs + project convention

- id: stripe-publishable-key-client
  pattern:
    finding_type: client-bundle-leak
    key_prefix: [pk_live_, pk_test_]
  reason: |
    Stripe publishable keys (pk_live_*, pk_test_*) are intentionally
    client-exposed. Per Stripe docs, they're safe to publish. Only sk_*
    and rk_* (secret / restricted) keys must remain server-only —
    those are still flagged P0 by check 5.2.
  expires: 2026-11-22
  source: Stripe API key docs

- id: nextjs-script-unsafe-inline-aspirational
  pattern:
    finding_type: csp-loose
    directive: script-src
    value: unsafe-inline
    file_glob: frontend/next.config.js
  reason: |
    Next.js 14 still emits inline scripts for hydration; removing
    'unsafe-inline' from script-src requires per-request nonce middleware
    which is not yet implemented. Tracked as an aspirational P2 follow-up
    in references/NEXT_HEADERS.md. Until nonces land, this is the least-bad
    state — DO NOT downgrade to a P0 finding.
  expires: 2026-08-22
  source: references/NEXT_HEADERS.md compatibility notes
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
2. **Pattern** specific enough to not collapse unrelated findings (include `file_glob` + `finding_type` at minimum)
3. **Reason** that links to a durable source (memory / ADR / ticket / public vendor docs — not "Bx said so in chat")
4. **Expiry** ≤ 6 months from creation (12 months acceptable for vendor-driven invariants like the Firebase web config). Renew explicitly if still valid then.

Never use suppressions to silence a finding you don't want to fix. The expiry forces a periodic re-evaluation; suppressions without expiries become tech debt.

## Empty-state behavior

If this file has zero active suppressions, the skill still emits the "Suppressed (0 findings)" header so the user can see at a glance that nothing is hidden.

# Suppressions — Known-Non-Findings (GCP)

Findings that match a pattern below are MOVED to the report's "Suppressed" section (not silently dropped — audit trail preserved). Suppressions MUST have an expiry date.

Format (informal — YAML-like):

```
- id: <stable-identifier>
  pattern: <how to match>
  reason: <why intentional>
  expires: YYYY-MM-DD
  source: <link to memory / ADR / ticket / vendor docs>
```

---

## Active suppressions

```
- id: api-public-ingress
  pattern:
    finding_type: cloud-run-public-ingress
    service: <api-service>
    ingress: all
  reason: |
    The public API service is the public FastAPI surface. The frontend service
    makes browser-originated requests to it. Public ingress is INTENTIONAL;
    security is enforced at the application layer via Firebase ID token bearer
    auth (backend/api/auth.py + router factories in backend/api/utils/router.py).
    Do NOT downgrade ingress to internal without also moving the frontend behind
    the same load balancer.
  expires: 2026-11-23
  source: backend/api/main.py + backend/api/utils/router.py

- id: frontend-public-ingress
  pattern:
    finding_type: cloud-run-public-ingress
    service: <frontend-service>
    ingress: all
  reason: |
    The frontend service is the public marketing + app surface. Public ingress
    is INTENTIONAL.
  expires: 2026-11-23
  source: public site by design

- id: api-allusers-invoker
  pattern:
    finding_type: cloud-run-allusers-invoker
    service: <api-service>
  reason: |
    allUsers=run.invoker on the API service is REQUIRED because the frontend's
    browser-originated requests are unauthenticated at the Cloud Run IAM layer
    (Firebase token is in the Authorization header, checked inside the app).
    Downgrading invoker auth without a load balancer + IAP would break the
    frontend.
  expires: 2026-11-23
  source: bearer-auth at app layer (auth.py)

- id: frontend-allusers-invoker
  pattern:
    finding_type: cloud-run-allusers-invoker
    service: <frontend-service>
  reason: |
    Public frontend MUST be reachable without invoker auth. Static assets and
    SSR'd marketing pages.
  expires: 2026-11-23
  source: public site by design
```

---

## NOT suppressed (deliberately surfaced every run)

The following findings are SURFACED on every run even though they're "known" — because they represent open work, not intentional decisions:

- `firestore-subscription-active-privesc` (Catalog 7.1) — a client-writable entitlement-field write hole. Will recur until `backend/firestore.rules` is amended. Do NOT add a suppression for this; the finding is the open work item.
- `caret-pin-on-firebase-*` — caret ranges on security-critical packages. Recurs until pinned.
- `next-config-missing-security-headers` — recurs until headers are configured.
- `stripe-webhook-stub` — recurs until the webhook signature check lands.

These typically cross-reference open tickets; the audit's job is to keep them visible until they're closed.

---

## How the skill applies suppressions

1. Run all checks per `CHECK_CATALOG.md`, collect findings.
2. For each finding, scan this file for a matching pattern.
3. If matched AND `expires` is in the future: move to "Suppressed" section.
4. If matched AND `expires` is in the past: emit at normal severity + P2 "expired suppression — review or renew".
5. If no match: emit at normal severity.

## Adding a new suppression

A new suppression MUST come with:

1. **Stable id** (kebab-case, descriptive — include service name where applicable)
2. **Pattern** specific enough not to collapse unrelated findings (include `finding_type` + `service` / `resource` at minimum)
3. **Reason** that links to a durable source (memory / ADR / vendor docs)
4. **Expiry** ≤ 6 months for project-specific suppressions, ≤ 12 months for vendor-driven invariants. Renew explicitly if still valid.

NEVER use suppressions to silence a finding the user doesn't want to fix. The expiry forces a periodic re-evaluation.

## Empty-state behavior

If this file has zero active suppressions, the skill still emits the "Suppressed (0 findings)" header so the user can see nothing is hidden.

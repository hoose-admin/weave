---
name: security-frontend
description: "Audits `frontend/` (Next.js 14 + React 18) for client-side weaknesses: XSS sinks, DOM-XSS via `searchParams`, open redirects, bearer-token + proxy-route header handling, Stripe webhook signature verification, OAuth callback state, custom-claim impersonation surface, secrets in the client bundle (`NEXT_PUBLIC_*`, `sk_*`), security headers (CSP/HSTS/COOP/COEP/etc.), dependency known-bad pins, postMessage origin checks, `next/image` SSRF allowlist, Server Actions caller validation. Full check matrix in `references/CHECK_CATALOG.md`. Produces P0/P1/P2 punch list with [OWASP category], CWE ID, file:line cites. Read-only; emits a `bun audit` script for the user. Does NOT cover backend (`security-backend`), GCP infra (`security-gcp`), or per-PR diff review (`/security-review`)."
when_to_use: "User says 'audit the frontend security', 'any XSS in the frontend?', 'is the bundle leaking keys?', 'check Next proxy headers', 'frontend dependency vulnerabilities', 'frontend CSP audit', 'Stripe webhook check', 'check open redirects', 'is the frontend leaking the Firebase token?'."
connects_to: []
kind: audit
---

# Security Frontend Audit

Read-only audit of `frontend/` (Next.js 14 App Router + React 18 + Firebase Web SDK) against the OWASP Top 10 (2021) and Next.js-specific attack surface. Produces a severity-ranked punch list with file:line cites.

The body holds the procedure and output contract. The full per-category check matrix lives in `${CLAUDE_SKILL_DIR}/references/CHECK_CATALOG.md` — read it at audit time, do not paraphrase from memory.

## When to invoke

- "audit the frontend security" / "full frontend security audit" → `audit-all`
- "any XSS in the frontend?" → `audit-xss`
- "check open redirects" / "redirect safety" → `audit-injection`
- "is the bundle leaking keys?" / "NEXT_PUBLIC audit" → `audit-bundle-leaks`
- "check Next proxy headers" / "are proxies forwarding cookies?" → `audit-proxies`
- "Stripe webhook check" / "OAuth callback audit" → `audit-webhooks`
- "frontend CSP audit" / "HSTS / security headers" → `audit-headers`
- "frontend dependency vulnerabilities" / "bun audit" → `audit-deps` (emits script)
- "Server Actions audit" / "use server caller check" → `audit-server-actions`

## When NOT to invoke

- **Backend security (FastAPI auth, BQ/Postgres injection, CORS, rate-limiting)** — `security-backend`
- **GCP infrastructure (Cloud Run ingress, IAM, Firestore rules, Secret Manager config)** — `security-gcp`
- **Per-PR diff review** — `/security-review` (built-in; reactive, change-scoped)
- **Full system-wide composition with merged report** — the `security` orchestrator skill (orchestrates this skill + sibling subskills)
- **Penetration testing / live exploits** — out of scope; static analysis only
- **Fixing findings** — read-only; user remediates

## Inputs

| param | default | meaning |
|---|---|---|
| `op=<name>` | `audit-all` | one of the trigger ops above |
| `severity=p0\|p1\|p2\|all` | `all` | filter output |
| `format=markdown\|json` | `markdown` | output format (JSON for orchestrator consumption) |
| `worm-range=<semver>` | (empty) | known-bad dependency version range (supplied by the project); until user provides, dep-audit reports drift only |

## Procedure

### 0. Read the check catalog

Read `${CLAUDE_SKILL_DIR}/references/CHECK_CATALOG.md`. This file owns the exact grep commands, regex patterns, file:line anchors, and per-finding severity ceilings for every check. The procedure below is the WORKFLOW; the catalog is the WHAT.

Read `${CLAUDE_SKILL_DIR}/references/SUPPRESSIONS.md` to load the allowlist of known-non-findings (e.g. Firebase web config keys are intentionally public). Suppressions are applied AFTER findings are collected.

### 1. Resolve scope

From the `op=` param, build the check-set:

- `audit-all` → every category
- `audit-xss` → Category 1 (XSS sinks, DOM-XSS, prototype pollution, open redirects, ReDoS)
- `audit-injection` → Category 1 subset (open redirect, prototype pollution)
- `audit-bundle-leaks` → Category 5 (NEXT_PUBLIC_* leaks, Stripe sk_*, source maps, console.log of tokens)
- `audit-proxies` → Category 3 subset (forwardAuthHeaders compliance, body forwarding caps)
- `audit-webhooks` → Webhook & OAuth category (Stripe signature, state param, custom-claim writes)
- `audit-headers` → Category 4 (CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy, COOP/COEP/CORP)
- `audit-deps` → Category 6 (dep pins, SRI, bun.lock freshness, postinstall hooks) — emits `bun audit` script
- `audit-server-actions` → Category 7 subset (Server Actions caller validation, middleware matcher correctness, dynamic param validation)

### 2. Run checks per the catalog

For each check in scope, follow the catalog's exact procedure. Always:

- Cite `file:line` for every finding (use the Grep tool with `-n` line numbers).
- Tag each finding with its OWASP category (`[OWASP A0X]`), CWE ID where available.
- Assign severity (P0/P1/P2) per the catalog's ceiling.
- Do NOT exceed the catalog's severity ceiling without an explicit reason in the finding body.

### 3. Read fresh — never assume

Three pieces of state MUST be re-read on every invocation:

- `frontend/next.config.js` — `env`, `headers()`, `images.remotePatterns` — drift here moves CSP/SSRF/leak posture
- `frontend/lib/proxy.ts` — `forwardAuthHeaders` shape; new helpers may have appeared
- `frontend/package.json` AND `frontend/bun.lock` — dependency pins drift on every PR; the known-bad-version warning (supplied by the project) is range-based

If `frontend/middleware.ts` appears (currently does NOT exist), pivot the headers check to its `headers()` block.

### 4. Apply suppressions

For every collected finding, check against `references/SUPPRESSIONS.md`:

- If matched AND `expires` is in the future: move to "Suppressed" section with reason + expiry.
- If matched AND `expires` is in the past: emit at normal severity + a separate P2 "expired suppression — review or renew".
- Never silently drop. Suppressed findings still appear (audit trail).

### 5. Emit findings

Format per the output contract. Order: P0 first, then P1, P2, then Suppressed.

### 6. Emit dependency scripts (audit-deps + audit-all)

```bash
# Run from frontend/ — checks against GitHub Advisory Database
cd frontend && bun audit
```

```bash
# Manual: grep the built bundle for accidentally-leaked secrets (run after `bun run build`)
grep -REn "sk_live_|sk_test_|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}" frontend/.next/static/chunks/ | head
```

Tell the user these are scripts to run themselves — the skill does NOT execute them (read-only invariant).

## Output format

```markdown
# Frontend Security Audit — YYYY-MM-DD HH:MM

**Scope:** <op>
**Anchors verified:** frontend/next.config.js, frontend/lib/proxy.ts, frontend/package.json + bun.lock
**Total findings:** N (P0: X, P1: Y, P2: Z, suppressed: W)

## P0 — Immediate

### [security-frontend] <short-title>
- **OWASP:** A0N — <category name>
- **CWE:** CWE-NNN — <name>
- **Cite:** `frontend/path/file.ts:42`
- **Detail:** <one-line description>
- **Suggested fix:** <one-line sketch>

## P1 — Soon
...

## P2 — Defense in depth
...

## Suppressed (N findings)
- `<finding-id>` — reason: <text>; expires: <YYYY-MM-DD>

## Dependency check scripts (run these manually)
<fenced code blocks: bun audit, bundle-leak grep>
```

When `format=json`, emit a JSON document with the same fields, one object per finding, so `/security` orchestrator can consume + merge + dedup with sibling subskills via the (CWE, normalized-resource) dedup key.

## Surface-specific notes

### Standalone Next routes have different threat models

- `frontend/app/api/stripe/` — Stripe webhook receiver. MUST verify signature against raw bytes; one of the highest-impact checks.
- `frontend/app/api/auth/` — login/signup callbacks. MUST validate OAuth `state` parameter. Must NEVER call `setCustomUserClaims` from user input (cross-ref security-backend Catalog 2.2).
- All other `frontend/app/api/<feature>/` directories are FastAPI proxies — must use `forwardAuthHeaders` from `lib/proxy.ts`.

### Firebase web config is intentionally public

The Firebase Web SDK ships `apiKey`, `authDomain`, `projectId`, etc. in the client bundle by design. These are NOT secrets — the security boundary is at Firebase Rules and Identity Platform, not key secrecy. Suppress any "API key in bundle" finding for these specific Firebase config keys (see `SUPPRESSIONS.md`).

### Stripe publishable vs secret keys

`pk_live_*` / `pk_test_*` (publishable) are intentionally client-exposed. `sk_live_*` / `sk_test_*` / `rk_live_*` / `rk_test_*` (secret/restricted) MUST NEVER appear in `frontend/`. The catalog's bundle-leak check distinguishes these.

### Known-bad dependency version ranges

A project may pin against a known-bad (compromised / supply-chain-tainted) version range and forbid blind dependency upgrades. The exact range is project-supplied, not built in. Until the user supplies the range via the `worm-range=` param or by adding it to `SUPPRESSIONS.md`, the dep-audit check records current pins and flags drift from them — it cannot positively identify the bad version.

## Prerequisites

- The Grep / Read tools (always available in Claude Code).
- `${CLAUDE_SKILL_DIR}/references/CHECK_CATALOG.md` and `${CLAUDE_SKILL_DIR}/references/SUPPRESSIONS.md` must exist (this skill ships them).
- For dep-audit scripts: `bun` available in the user's shell (only if they run the emitted script; skill itself needs nothing executable).

## References

- `${CLAUDE_SKILL_DIR}/references/CHECK_CATALOG.md` — exhaustive 7-category check matrix with exact grep commands, regex patterns, file:line anchors, severity ceilings. READ THIS at audit time; do not paraphrase from memory.
- `${CLAUDE_SKILL_DIR}/references/OWASP_TOP_10.md` — OWASP Top 10 (2021) category index with one-line summaries. Use to tag findings.
- `${CLAUDE_SKILL_DIR}/references/NEXT_HEADERS.md` — canonical CSP / HSTS / Referrer-Policy / Permissions-Policy / COOP-COEP-CORP recommendations for Next.js 14 App Router, with a copy-pasteable `next.config.js` `headers()` block.
- `${CLAUDE_SKILL_DIR}/references/SUPPRESSIONS.md` — allowlist of known-non-findings (Firebase web config keys, Stripe publishable, etc.) with expiry dates.

External (do not bundle; cite by URL in findings):
- OWASP Top 10 (2021) — https://owasp.org/Top10/
- OWASP Cheat Sheet Series — https://cheatsheetseries.owasp.org/
- MDN Content Security Policy — https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP
- Next.js CSP guide — https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy
- Stripe webhook signatures — https://stripe.com/docs/webhooks#verify-events

## After every operation

1. Suppression hygiene: if any suppression expired this run, recommend the user file a ticket to renew or remove.
2. If new findings appeared that weren't present last run, recommend invoking the `security` orchestrator skill for full snapshot diff.
3. Re-emit the dep-audit + bundle-grep scripts as a closing reminder — SAST drift between runs is the #1 source of P0 surprises.

# Frontend Security Check Catalog

A 7-category threat model. Each check is **executable** — exact Grep pattern, exact file scope, severity ceiling, OWASP/CWE tag.

**Severity ceiling** is the worst grade a finding in that bucket can earn. Exceed only with explicit justification in the finding body.

**Output tag** is what the skill stamps on the finding (`[OWASP A0N CWE-NNN]`).

All Grep commands assume `frontend/` as the scope and exclude `node_modules`, `.next`, `dist` (Grep tool defaults to repo-root excludes for these; pass an explicit `glob` if needed).

---

## Category 1 — Injection & Code Execution (OWASP A03, CWE-79/CWE-94/CWE-1321/CWE-601)

### 1.1 — XSS sinks
- **What:** Zero `dangerouslySetInnerHTML` / `innerHTML` / `outerHTML` / `document.write` / `insertAdjacentHTML` / `eval` / `new Function(` in `frontend/`. Expected baseline: **zero** matches.
- **Grep:** `Grep "dangerouslySetInnerHTML|innerHTML|outerHTML|document\.write|insertAdjacentHTML|\\beval\\(|new Function\\(" --glob "frontend/**/*.{ts,tsx,js,jsx}" -n`
- **Severity ceiling:** P0
- **Tag:** `[OWASP A03 CWE-79]`

### 1.2 — DOM-XSS via location / searchParams
- **What:** React components reading `useSearchParams()` / `window.location.*` / route `params` and flowing the value into a sink (`href`, `src`, `srcdoc`, `style`, `setAttribute`) without sanitization.
- **Grep:**
  - `Grep "useSearchParams\\(\\)|window\\.location\\." --glob "frontend/**/*.{ts,tsx}" -n` — collect components
  - For each, read the file and check if any value flows into `href={...}` / `src={...}` / `dangerouslySetInnerHTML` etc.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A03 CWE-79]`

### 1.3 — Prototype pollution
- **What:** `Object.assign({}, untrustedObj)` / `_.merge` / `lodash.merge` / spread of untrusted JSON into existing objects.
- **Grep:** `Grep "Object\\.assign\\(|_\\.merge\\(|lodash\\.merge\\(" --glob "frontend/**/*.{ts,tsx,js,jsx}" -n`
- **Severity ceiling:** P1
- **Tag:** `[OWASP A03 CWE-1321]`

### 1.4 — Open redirect
- **What:** `router.push` / `redirect()` / `NextResponse.redirect(...)` reading from `searchParams` / `request.url` / form input without allowlist.
- **Grep:** `Grep "router\\.push\\(|redirect\\(|NextResponse\\.redirect\\(" --glob "frontend/**/*.{ts,tsx}" -n`. For each, inspect the URL argument; flag any user-controlled value.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A01 CWE-601]`

### 1.5 — ReDoS
- **What:** `new RegExp(userValue)` or user-input-fed regex with O(n²) complexity (alternation + nested quantifiers).
- **Grep:** `Grep "new RegExp\\(" --glob "frontend/**/*.{ts,tsx}" -n`. Inspect each.
- **Severity ceiling:** P2
- **Tag:** `[OWASP A03 CWE-1333]`

---

## Category 2 — Auth, Sessions, Access Control (OWASP A01/A07, CWE-287/CWE-352/CWE-915)

### 2.1 — Bearer-only auth invariant
- **What:** No `Set-Cookie` / `cookies()` reads for auth purposes (CSRF surface). Bearer-only auth model (no auth cookies).
- **Grep:** `Grep "Set-Cookie|cookies\\(\\)\\.set|cookies\\(\\)\\.get|next/headers.*cookies" --glob "frontend/**/*.{ts,tsx}" -n -i`. P0 if any cookie auth snuck in (would invalidate CSRF assumptions).
- **Severity ceiling:** P0
- **Tag:** `[OWASP A07 CWE-352]`

### 2.2 — Firebase ID token storage
- **What:** Firebase ID token MUST NOT be manually persisted to `localStorage` / `sessionStorage` / `IndexedDB` outside Firebase SDK's managed store.
- **Grep:** `Grep "localStorage\\.|sessionStorage\\.|indexedDB" --glob "frontend/**/*.{ts,tsx}" -n`. For each match, check it's not storing `idToken` / `accessToken` / `Authorization`.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A02 CWE-922]`

### 2.3 — setCustomUserClaims in client-reachable paths
- **What:** `setCustomUserClaims` (or `set_custom_user_claims` in any embedded Python) MUST NOT be called from a user-reachable Next.js API route or client code. Custom-claim writes are server-Admin-SDK-only.
- **Grep:** `Grep "setCustomUserClaims|set_custom_user_claims" --glob "frontend/**" -n`. P0 if found in `frontend/app/api/auth/` or any client-reachable surface.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A02 CWE-863]`

### 2.4 — Sign-out cache cleanup
- **What:** Sign-out clears TanStack-Query cache AND any persisted session storage (memory-cache, IDB).
- **Grep:** Locate sign-out handler (`signOut` / `auth.signOut`). Inspect surrounding code for `queryClient.clear()` / `queryClient.removeQueries()`. P1 if partial cleanup.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A07 CWE-613]`

### 2.5 — Account-linking impersonation surface
- **What:** Identity Platform / Firebase account-linking flows MUST NOT let a user supply a server-trusted `uid` / `email` claim.
- **Grep:**
  - `Read frontend/lib/identity-platform.ts`
  - `Read frontend/app/api/auth/*` (if exists)
  - Inspect any path that accepts user-provided identity claims and forwards to a backend that trusts them.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A07 CWE-287]`

---

## Category 3 — Proxy Routes & Header Forwarding (OWASP A05, CWE-200/CWE-770)

### 3.1 — forwardAuthHeaders compliance
- **What:** Every proxy route under `frontend/app/api/**/route.ts` uses `forwardAuthHeaders` from `lib/proxy.ts:4-12` (not custom header-forwarding). Excludes `app/api/stripe/` and `app/api/auth/` (different threat model — handled by Category 8).
- **Grep:**
  - `Grep "fetch\\(" --glob "frontend/app/api/**/route.ts" -n` — collect backend-call sites
  - For each, verify `forwardAuthHeaders` is used. Flag any route that constructs its own `Headers()` or forwards `cookie` / custom headers.
- **Severity ceiling:** P1 (P0 if cookies forwarded — exposes session)
- **Tag:** `[OWASP A05 CWE-200]`

### 3.2 — Body forwarding caps
- **What:** Proxy routes do NOT forward the incoming request body to the backend without size/timeout caps (DoS amplification).
- **Grep:** `Grep "request\\.body|await request\\.json\\(\\)|await request\\.text\\(\\)" --glob "frontend/app/api/**/route.ts" -n`. For each, verify a body-size check exists.
- **Severity ceiling:** P2
- **Tag:** `[OWASP A04 CWE-770]`

---

## Category 4 — Cross-Origin & Embedding (OWASP A05, CWE-1021/CWE-346)

### 4.1 — CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy, COOP/COEP/CORP
- **What:** `next.config.js` `headers()` block OR `frontend/middleware.ts` MUST set:
  - `Content-Security-Policy` (default-src 'self'; script-src 'self' 'nonce-...'; etc. — see `NEXT_HEADERS.md`)
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
  - `X-Frame-Options: DENY` (or CSP `frame-ancestors 'none'`)
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy` (deny camera/microphone/geolocation/payment unless needed)
  - `Cross-Origin-Opener-Policy: same-origin` / `Cross-Origin-Embedder-Policy: require-corp` (aspirational)
- **Grep:** `Read frontend/next.config.js`. Confirm `async headers()` returns the policy. If `frontend/middleware.ts` exists, also read it.
- **Severity ceiling:** P2 (missing entirely) / P1 (present but loose — `'unsafe-eval'`, `'unsafe-inline'` without nonce, `*` source)
- **Tag:** `[OWASP A05 CWE-1021]`

### 4.2 — target="_blank" without rel="noopener noreferrer"
- **What:** Every `<a target="_blank">` carries `rel="noopener noreferrer"` to prevent window.opener leaks.
- **Grep:** `Grep "target=\"_blank\"|target={['\\\"]_blank['\\\"]}" --glob "frontend/**/*.{tsx,jsx}" -n`. For each, check the same element has `rel=` with both `noopener` AND `noreferrer`.
- **Severity ceiling:** P2
- **Tag:** `[OWASP A05 CWE-1022]`

### 4.3 — postMessage origin checks
- **What:** Every `window.addEventListener('message', ...)` handler MUST check `event.origin` against an allowlist.
- **Grep:** `Grep "addEventListener\\(['\"]message['\"]" --glob "frontend/**/*.{ts,tsx,js,jsx}" -n`. P0 if origin-check missing.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A05 CWE-346]`

### 4.4 — iframe sandboxing
- **What:** `<iframe>` rendering user-supplied URLs MUST carry `sandbox` attribute.
- **Grep:** `Grep "<iframe " --glob "frontend/**/*.{tsx,jsx}" -n`. Inspect each for user-controlled `src` + missing `sandbox`.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A05 CWE-1021]`

### 4.5 — Service Worker scope
- **What:** If a Service Worker exists (`frontend/public/sw.js` or any `navigator.serviceWorker.register` call), inspect its scope and write paths.
- **Grep:**
  - `ls frontend/public/sw.js 2>/dev/null` — check for SW file
  - `Grep "serviceWorker\\.register" --glob "frontend/**/*.{ts,tsx,js,jsx}" -n`
  - For each SW present, `Read` the file and verify: (a) `/api/` is excluded from caching, (b) only GET requests handled, (c) no untrusted-source write path
- **Severity ceiling (calibrated):**
  - **P0** if SW caches `/api/` responses (token-bearing requests get persisted to the cache) OR writes from any untrusted source (postMessage, third-party push).
  - **P1** if SW exists but doesn't explicitly exclude `/api/`, OR handles non-GET requests (PUT/POST cache poisoning).
  - **P2 informational** if SW present and properly scoped (the typical case — surface for transparency, not as a finding to fix).
- **Tag:** `[OWASP A05 CWE-829]`
- **Why this calibration:** A uniform P1 ceiling misrepresents the risk when a Service Worker is properly scoped (excludes `/api/`, GET-only, no untrusted write path). Severity keys off the specific failure mode rather than mere SW presence.

### 4.5.bis — Service Worker fetch interception caveat
- **What:** Service workers can intercept `fetch()` calls; any SW that proxies requests to the FastAPI backend MUST forward the `Authorization` header. (Less common but worth checking if SW exists.)
- **Grep:** Same SW files; look for `fetch(event.request)` patterns. Verify headers are preserved or explicitly re-added.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A05 CWE-200]`

---

## Category 5 — Client-Bundle Leaks (OWASP A02, CWE-200/CWE-540)

### 5.1 — NEXT_PUBLIC_* and next.config.js env block
- **What:** No `process.env.NEXT_PUBLIC_*` name matching `*SECRET*` / `*PRIVATE*` / `*_KEY` (except allowlist: Firebase web config keys, Stripe `pk_*` publishable, GoogleMaps public if used — see `SUPPRESSIONS.md`).
- **Grep:**
  - `Grep "process\\.env\\.NEXT_PUBLIC_" --glob "frontend/**/*.{ts,tsx,js,jsx}" -n` — collect references
  - `Read frontend/next.config.js` — check `env:` block doesn't pass private vars
- **Severity ceiling:** P0
- **Tag:** `[OWASP A02 CWE-200]`

### 5.2 — Stripe secret key in client
- **What:** No `sk_live_*` / `sk_test_*` / `rk_live_*` / `rk_test_*` anywhere in `frontend/`.
- **Grep:** `Grep "sk_live_|sk_test_|rk_live_|rk_test_" --glob "frontend/**" -n`. P0 for any match.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A02 CWE-540]`

### 5.3 — Source maps in production
- **What:** `next.config.js` does NOT enable `productionBrowserSourceMaps: true` (production source maps expose original source).
- **Grep:** `Grep "productionBrowserSourceMaps" frontend/next.config.js -n`. P1 if set to `true`.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A05 CWE-540]`

### 5.4 — Bundle grep emit
- **What:** Emit a script (not executed) for the user to grep the built `.next/static/chunks/*.js` artifacts for accidentally-bundled secrets.
- **Action:** Emit the bundle-grep script in the output's "Dependency check scripts" section.
- **Severity ceiling:** P0 if user reports findings; otherwise no finding.

### 5.5 — console.log of tokens
- **What:** No `console.log` / `console.info` / `console.warn` / `console.error` / `console.debug` near `idToken` / `accessToken` / `Authorization` variables.
- **Grep:** `Grep "console\\.(log|info|warn|error|debug).*\\b(idToken|accessToken|Authorization|bearer)\\b" --glob "frontend/**/*.{ts,tsx,js,jsx}" -n -i`.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A09 CWE-532]`

---

## Category 6 — Dependencies & Supply Chain (OWASP A06/A08, CWE-1104)

### 6.1 — Known-bad pins (project-supplied bad version range)
- **What:** Record current pins from `frontend/package.json` + `frontend/bun.lock`. Diff against the user-supplied known-bad list.
- **Grep:** `Read frontend/package.json` (dependencies + devDependencies). If `worm-range=` param provided, check against it.
- **Severity ceiling:** P0 if match; otherwise informational
- **Tag:** `[OWASP A06 CWE-1104]`

### 6.2 — Caret-range drift on security-critical packages
- **What:** Flag `^` / `~` ranges on: `firebase`, `firebase-admin`, `next`, `@tanstack/react-query`, `@tanstack/react-query-persist-client`, `react`, `react-dom`.
- **Grep:** Inspect `package.json` deps; flag any with `^` or `~` prefix on the above list.
- **Severity ceiling:** P2
- **Tag:** `[OWASP A06 CWE-1104]`

### 6.3 — Subresource Integrity (SRI)
- **What:** Every `<script src="https://...">` referencing a third-party CDN carries `integrity="sha384-..."`.
- **Grep:** `Grep "<script src=\"https://" --glob "frontend/**/*.{tsx,jsx,html}" -n`. P1 for each match without `integrity=`.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A08 CWE-353]`

### 6.4 — bun.lock freshness
- **What:** `bun.lock` is committed AND matches `package.json` (no drift). The project may forbid blind `bun update`.
- **Action:** Verify `frontend/bun.lock` exists. Cross-check: any dep in `package.json` not in lockfile is a drift signal.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A06 CWE-1357]`

### 6.5 — postinstall hooks
- **What:** Audit `bun.lock` for packages declaring `postinstall` hooks; list new ones vs last-known baseline for user review.
- **Action:** `Grep "postinstall" frontend/bun.lock -n` → emit list.
- **Severity ceiling:** P2
- **Tag:** `[OWASP A08 CWE-1104]`

### 6.6 — bun audit emit
- **What:** Emit `cd frontend && bun audit` script for the user. Skill does NOT execute.
- **Action:** Emit in output's "Dependency check scripts" section.

---

## Category 7 — Next.js-Specific (OWASP A05, Next 14 App Router)

### 7.1 — next/image SSRF
- **What:** `next.config.js` `images.remotePatterns` is an explicit allowlist (NOT `**` / `*` / open scheme).
- **Grep:** `Read frontend/next.config.js`. Inspect `images.remotePatterns`. P1 if any entry uses `**` host or unscoped scheme.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A10 CWE-918]`

### 7.2 — Server Actions caller validation
- **What:** Every `'use server'` directive's actions MUST validate caller identity, not trust form payload.
- **Grep:** `Grep "'use server'|\"use server\"" --glob "frontend/**/*.{ts,tsx}" -n`. For each file, inspect actions for explicit auth check (Firebase token verify / Cookie / session). P0 if missing.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A01 CWE-862]`

### 7.3 — middleware.ts matcher correctness
- **What:** If `frontend/middleware.ts` exists, the `matcher` config covers what it claims (regex correctness check; e.g. excluding `_next/` doesn't accidentally exclude protected routes).
- **Grep:** `Read frontend/middleware.ts` if it exists. Inspect `matcher`. (If the file does not exist, this check is N/A.)
- **Severity ceiling:** P1
- **Tag:** `[OWASP A05 CWE-697]`

### 7.4 — Dynamic route param validation
- **What:** Dynamic route params (`[id]`, `[uid]`, `[slug]`, etc.) are validated against an allowlist / shape regex before downstream use. Applies to BOTH page routes (`app/**/page.tsx`) AND API routes (`app/api/**/route.ts`).
- **Glob (note — a naive `frontend/app/**/\\[*\\]/page.tsx` pattern can fail to match due to bracket escaping):**
  - Page routes: `Glob "frontend/app/**/page.tsx"` then path-filter results for any segment matching `/\[[^\]]+\]/` (e.g. `[id]`, `[slug]`).
  - API routes: `Glob "frontend/app/api/**/route.ts"` then same path-filter (dynamic-param route files — `[id]`, `[slug]`, `[uid]`, etc.).
  - Alternative (single-pass): `Grep "params:\\s*Promise<\\{|params:\\s*\\{" --glob "frontend/app/**/*.{ts,tsx}" -n` to find all handlers that destructure dynamic params; for each, verify validation.
- **For each match:** Read the handler; verify the dynamic param value flows through a validator (regex match, allowlist lookup, parseInt with bounds) BEFORE being passed to `fetch(<backend URL with ${param}>)` or any DOM sink.
- **Severity ceiling:**
  - **P0** if a dynamic param flows DIRECTLY into a DOM sink without validation (XSS / DOM-XSS).
  - **P1** if a dynamic param flows into a `fetch()` URL toward the backend without validation (the backend should also validate, but defense-in-depth at the proxy hop matters).
  - **P2** if validation exists but is loose (e.g. regex `/.+/` instead of a tight shape).
- **Tag:** `[OWASP A01 CWE-20]`
- **Why this matters:** A bracket-escaped glob can silently return zero matches even when dynamic page routes exist; and API routes under `app/api/**/route.ts` carry the same risk as page routes. Cover both surfaces.

---

## Category 8 — Stripe Webhook & OAuth Callbacks (different threat model from proxies)

### 8.1 — Stripe webhook signature verification
- **What:** `frontend/app/api/stripe/` MUST verify webhook signature via `Stripe.webhooks.constructEvent(rawBody, sig, secret)`. Signature MUST be checked against RAW BYTES, not JSON-parsed body.
- **Grep:**
  - `Grep "stripe|webhook" --glob "frontend/app/api/stripe/**/*.{ts,tsx}" -n -i`
  - Verify `constructEvent` called BEFORE any `JSON.parse(body)`.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A02 CWE-345]`

### 8.2 — Webhook event.id idempotency
- **What:** Webhook handler records processed `event.id` to prevent double-processing on retry.
- **Grep:** In the same Stripe handler, look for `event.id` being persisted or checked against a dedup store.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A04 CWE-345]`

### 8.3 — OAuth callback state validation
- **What:** OAuth callback routes MUST validate `state` parameter against originating request (CSRF).
- **Grep:**
  - `Grep "state|nonce" --glob "frontend/app/api/auth/**/*.{ts,tsx}" -n -i`
  - Inspect for state-validation logic.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A07 CWE-352]`

---

## Cross-references to sibling skills

- **Backend FastAPI auth, CORS, BQ injection** — `security-backend`
- **GCP IAM, Cloud Run ingress, Firestore rules** — `security-gcp`
- **Per-PR diff review** — `/security-review`
- **Composition / dedup / snapshot diff** — the `security` orchestrator skill

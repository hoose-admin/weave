# Backend Security Check Catalog

A 9-category threat model. Each check is **executable** — exact Grep pattern, exact file scope, severity ceiling, OWASP/CWE tag.

The skill body says "for each check in scope, follow the catalog's exact procedure" — this file IS that procedure.

**Severity ceiling** is the worst grade a finding in that bucket can earn. Exceed only with explicit justification in the finding body.

**Output tag** is what the skill stamps onto the finding (`[OWASP API #N CWE-NNN]`).

---

## Category 1 — Broken Object-Level Authorization (API #1 BOLA, CWE-639)

### 1.1 — Router-factory coverage
- **What:** Every router in `_ALL_ROUTERS` (`backend/api/main.py:55-69`) MUST be built via `authed_router()` / `subscriber_router()` / `public_router()` (`backend/api/utils/router.py:11-33`). Bare `APIRouter()` = no auth tier.
- **Grep:** `Grep "APIRouter\(" --type py -n` in `backend/api/`. Cross-reference against `utils/router.py`'s three factories.
- **Severity ceiling:** P0
- **Tag:** `[OWASP API #1 CWE-862]`

### 1.2 — BOLA on path-param endpoints
- **What:** Endpoints with `/{symbol}` / `/{uid}` / `/{id}` / `/{user_id}` in the path MUST validate the caller owns / has access to that object — not just that they're authed.
- **Grep:** `Grep "@router\.(get|post|put|delete|patch)\(['\"][^'\"]*\{(symbol|uid|id|user_id)\}" --type py -n` in `backend/api/`. For each match, READ the handler body and verify it checks `decoded["uid"] == path_uid` (or equivalent ownership check). P0 if the handler accepts the path param without an ownership predicate.
- **Severity ceiling:** P0
- **Tag:** `[OWASP API #1 CWE-639]`

### 1.3 — BFLA (Broken Function-Level Auth)
- **What:** Admin-only handlers reachable from `authed_router` (vs. an `admin_router` that doesn't exist) without an explicit role check.
- **Grep:** `Grep "(admin|backfill|sync|delete_all|recompute|impersonate)" --type py -n -i` in `backend/api/`. For each match, check if the handler is on an `authed_router` (not subscriber/admin tier) AND lacks `if not decoded.get("admin"):` style check.
- **Severity ceiling:** P0
- **Tag:** `[OWASP API #5 CWE-285]`

### 1.4 — Mass Assignment (BOPLA)
- **What:** Pydantic request models accepting fields the user shouldn't be able to set (`user_id`, `is_admin`, `subscriptionActive`, `created_at`, `updated_at`). Models should declare `model_config = ConfigDict(extra="forbid")`.
- **Grep:** `Grep "class .*\(BaseModel\)" --type py -n` in `backend/api/`. For each model, READ the body and check (a) no sensitive fields like `user_id` / `is_admin` / `subscriptionActive` are user-settable, (b) `extra="forbid"` is set OR every field is intentional.
- **Severity ceiling:** P0
- **Tag:** `[OWASP API #6 CWE-915]`

### 1.5 — Improper Inventory Management
- **What:** Reachable `/v1/`, `/v2/`, `/internal/`, `/debug/`, `/admin/` paths without explicit auth tier.
- **Grep:** `Grep "prefix=['\"](/v\d+|/internal|/debug|/admin)" --type py -n` in `backend/api/`. P1 if any such prefix is on an `authed_router` or `public_router` (should be admin-only).
- **Severity ceiling:** P1
- **Tag:** `[OWASP API #9 CWE-1059]`

---

## Category 2 — Broken Authentication (API #2, CWE-287/CWE-345)

### 2.1 — Firebase token verification shape
- **What:** `backend/api/auth.py:60-90` `verify_firebase_token`: fail-closed on any error, no `alg=none` acceptance, uses Firebase Admin SDK `verify_id_token` (NOT a custom decoder).
- **Grep:** `Read backend/api/auth.py`. Confirm `verify_id_token` is called (Firebase SDK handles aud/iss/exp/sig internally). P0 if a custom `jwt.decode` / `verify=False` snuck in.
- **Severity ceiling:** P0
- **Tag:** `[OWASP API #2 CWE-287]`

### 2.2 — Custom-claim impersonation surface
- **What:** Only admin-gated paths may call `set_custom_user_claims`. User-controlled input must NEVER flow into claim values.
- **Grep:** `Grep "set_custom_user_claims|setCustomUserClaims" --type py -n` in `backend/`. For each call site, READ the surrounding code to verify (a) admin-only reachability, (b) values are server-derived, not from request body / query params.
- **Severity ceiling:** P0
- **Tag:** `[OWASP API #2 CWE-863]`

### 2.3 — Constant-time comparisons
- **What:** Token / signature / HMAC comparisons MUST use `hmac.compare_digest` or `secrets.compare_digest`, NOT `==`.
- **Grep:** `Grep "(token|signature|hmac|digest|secret).*==|==.*(token|signature|hmac|digest|secret)" --type py -n -i` in `backend/`. Filter out trivial cases (variable name `signature` compared to unrelated values); inspect any plausible match.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A02 CWE-208]` (observable timing discrepancy)

### 2.4 — Subscription cache poisoning
- **What:** `auth.py:106-156` `_subscription_active_cached`: only successful Firestore lookups cached. Confirm the docstring still describes this; verify the implementation matches.
- **Grep:** `Read backend/api/auth.py` (lines 106-156). Confirm `_subscription_cache[uid] = active` only inside the `try` block AND the `except` branch returns `False` WITHOUT caching. P1 if regressed.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A04 CWE-693]`

---

## Category 3 — Injection (OWASP A03, CWE-89/CWE-77/CWE-22/CWE-94/CWE-502)

### 3.1 — BigQuery SQL injection
- **What:** Zero `f"SELECT ... {var}"` / `.format()` / `%` formatting near `bq.query(...)` call sites.
- **Grep:**
  - `Grep "bq\.query|client\.query" --type py -n` in `backend/` — collect call sites
  - `Grep "f[\"']SELECT|f[\"']INSERT|f[\"']UPDATE|f[\"']DELETE|\\.format\\(.*SELECT" --type py -ni` in `backend/` — collect f-string SQL sites
  - For each call site, read ±20 lines and classify the interpolated values
  - Typical state: API-container BQ calls are parameterized (e.g. via a query-param helper like `utils/qp.py` + `utils/bigquery.py`); an analytics container may have internal f-string SQL sites using server-controlled identifiers (`{target}`, `{bq.project_id}.{dataset}.{table}`, internal `{sql_in}` lists). Counts will vary.
- **Severity ceiling (calibrated):**
  - **P0** for any f-string SQL in `backend/api/` (user-facing request handlers — drift here = exploitable).
  - **P0** for any f-string SQL where the interpolated value clearly traces back to a CLI arg, request param, or other caller-supplied string (e.g. a script interpolating a CLI arg into an `IN` clause).
  - **P1** for f-string SQL in `backend/analytics/` (sync scripts, services, utils) that interpolates only server-controlled identifiers (table names, dataset IDs, internal aggregate aliases). Not exploitable today but ANY refactor that lets caller input flow in becomes an immediate vulnerability; flag as drift risk.
  - **P2** if the f-string interpolates only literal constants (no variable expansion).
- **Tag:** `[OWASP A03 CWE-89]`
- **Why this calibration:** A uniform P0 ceiling over-reports when most analytics-container hits interpolate server-side identifiers not reachable from API request paths — that noise would hide a genuine P0 (e.g. an argv-driven `IN` clause). Calibration preserves the genuine P0 while accurately ranking the latent-risk P1s.

### 3.2 — Postgres / Cloud SQL injection
- **What:** If Cloud SQL is wired (a `db_password` secret suggests yes), all Postgres queries use `$1` / `%s` placeholders for VALUES and `psycopg2.sql.Identifier()` for table/column NAMES, NEVER f-strings.
- **Grep:**
  - First, detect Postgres usage: `Grep "asyncpg|psycopg2|psycopg|sqlalchemy" --type py -n` in `backend/`
  - If found: `Grep "execute|executemany|fetch_all|fetch_one|fetchrow" --type py -n` and inspect each call site
  - Distinguish value-injection (parameters) from identifier-injection (table/column names)
- **Severity ceiling (calibrated):**
  - **P0** if any user-controlled value is f-string interpolated into a query (data injection).
  - **P1** if helper functions f-string interpolate caller-supplied table/column names while using `%s` for values (e.g. helpers in a `utils/db.py` — pattern is locally safe because callers pass internal identifiers, but the helper API invites future misuse; remediation is `psycopg2.sql.Identifier()`).
  - **P2** if all interpolated identifiers are literal constants.
- **Tag:** `[OWASP A03 CWE-89]`
- **Why this calibration:** When `db.py` helpers take caller-controlled table/column args but parameterize values via `%s`, only identifiers are interpolated. With no user-input path, P1 is the honest ceiling: not exploitable today, but one bad caller away from exploit. Remediation (`psycopg2.sql.Identifier()`) is usually already available in-repo — just not consistently applied.

### 3.3 — Command injection
- **What:** No user-derived input flows into `subprocess.run` / `os.system` / `os.popen` / `eval` / `exec` / `compile`.
- **Grep:** `Grep "subprocess\.(run|call|Popen)|os\.(system|popen)|\beval\(|\bexec\(|\bcompile\(" --type py -n` in `backend/`. For each match, READ surrounding code to verify no user input flows in.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A03 CWE-77]` (command injection) / `[CWE-94]` (code injection for eval/exec)

### 3.4 — Path traversal
- **What:** No user-controlled paths in `open(` / `Path(` / `os.path.join(` (`..` traversal risk).
- **Grep:** `Grep "\bopen\(|Path\(|os\.path\.join\(" --type py -n` in `backend/`. For each match, check if the path argument is or contains user input.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A01 CWE-22]`

### 3.5 — Unsafe deserialization
- **What:** No `pickle.loads` / `yaml.load` (without `SafeLoader`) / `marshal.loads` / `shelve.open` on untrusted data.
- **Grep:** `Grep "pickle\.loads?|yaml\.load[^_]|marshal\.loads?|shelve\.open" --type py -n` in `backend/`. For each match, check if input is from user / network / untrusted source. `yaml.load(stream, Loader=SafeLoader)` is safe; `yaml.load(stream)` is NOT.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A08 CWE-502]`

### 3.6 — Server-side template injection
- **What:** No `jinja2.Template(...)` / `render_template_string(...)` with user-controlled template string.
- **Grep:** `Grep "jinja2\.Template|render_template_string|Template\(.*request" --type py -n` in `backend/`. P0 if template body is user-controlled.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A03 CWE-94]`

### 3.7 — Log injection (CRLF)
- **What:** User input passed to `logger.*` uses structured args, not f-strings.
- **Grep:** `Grep "logger\.(info|warning|error|debug|exception)\(f[\"']" --type py -n` in `backend/`. P2 for each f-string log call that interpolates user input.
- **Severity ceiling:** P2
- **Tag:** `[OWASP A09 CWE-117]`

### 3.8 — Header response splitting
- **What:** User input never flows into response header values without `\r\n` filtering.
- **Grep:** `Grep "response\.headers\[|Header\(.*request\.|set.*header.*request" --type py -n -i` in `backend/api/`. Inspect each for user-derived values.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A03 CWE-113]`

---

## Category 4 — Unrestricted Resource Consumption (API #4, CWE-770)

### 4.1 — Rate-limit coverage on BQ routes
- **What:** Every route importing from `utils.bigquery` carries `@limiter.limit(EXPENSIVE_LIMIT)` or equivalent.
- **Grep:**
  - `Grep "from utils\.bigquery|from \.utils\.bigquery|import bigquery" --type py -l` in `backend/api/` — collect importing files
  - For each, `Grep "@limiter\.limit|@limiter\.exempt" --type py -n` in that file
  - P1 if any handler in a BQ-importing file lacks a limiter decorator (or router-level default).
- **Severity ceiling:** P1
- **Tag:** `[OWASP API #4 CWE-770]`

### 4.2 — Rate-limit coverage globally
- **What:** Every non-exempt route in `_ALL_ROUTERS` carries a limiter (route or router-level default).
- **Grep:** Walk `backend/api/main.py:55-69` router list; for each router file, count `@router.(get|post|...)` decorators vs `@limiter.limit` / `@limiter.exempt` decorators. P1 if shortfall.
- **Severity ceiling:** P1
- **Tag:** `[OWASP API #4 CWE-770]`

### 4.3 — IP-keyed rationale preserved
- **What:** `backend/api/rate_limit.py` uses `get_remote_address`, NOT UID-keyed (forged-UID DoS amplification risk). Lines 1-13 document why.
- **Grep:** `Read backend/api/rate_limit.py` lines 1-30. Confirm `key_func=get_remote_address`. P0 if changed to UID-keyed without an ADR justifying the change.
- **Severity ceiling:** P0
- **Tag:** `[OWASP API #4 CWE-693]`

### 4.4 — Public-endpoint abuse caps
- **What:** Every `public_router()` route has explicit payload + symbol/date caps. Reference: `/public/sparklines` has `PUBLIC_MAX_SYMBOLS=25`, `PUBLIC_MAX_DAYS=90`.
- **Grep:** From `main.py:55-69`, identify routers built via `public_router`. For each, read the handler bodies and verify caps exist. P0 if a public route has neither rate-limit NOR caps; P1 if only one.
- **Severity ceiling:** P0
- **Tag:** `[OWASP API #4 CWE-770]`

### 4.5 — Pagination limits
- **What:** Every list endpoint enforces a max `limit` parameter.
- **Grep:** `Grep "limit:\s*int|limit:\s*Optional\[int\]" --type py -n` in `backend/api/`. For each, verify a max value is enforced (e.g. `Query(..., le=1000)`).
- **Severity ceiling:** P1
- **Tag:** `[OWASP API #4 CWE-770]`

### 4.6 — Max body size
- **What:** uvicorn / Starlette enforces a max request body size (default ~1MB multipart; verify or set).
- **Grep:** `Grep "limit_max_requests|limit_concurrency|max_size|limit_request" --type py -n` in `backend/`. P1 if no explicit cap.
- **Severity ceiling:** P1
- **Tag:** `[OWASP API #4 CWE-400]`

### 4.7 — uvicorn timeouts (slowloris)
- **What:** `timeout-keep-alive` / `timeout-graceful-shutdown` configured.
- **Grep:** `Read backend/api/Dockerfile` (or wherever uvicorn is invoked). Look for `--timeout-keep-alive`. P2 if missing.
- **Severity ceiling:** P2
- **Tag:** `[OWASP A05 CWE-400]`

---

## Category 5 — Server-Side Request Forgery (API #7, CWE-918)

### 5.1 — User-controlled URL fetch
- **What:** Any `requests.get` / `httpx.get` / `urllib.request` / `aiohttp.ClientSession` with user-controlled URL MUST have a scheme + host allowlist.
- **Grep:** `Grep "(requests|httpx|urllib\.request|aiohttp)\.(get|post|put|delete|request|ClientSession)" --type py -n` in `backend/`. For each, trace the URL argument — if it comes from request body / query / path, verify allowlist.
- **Severity ceiling:** P0
- **Tag:** `[OWASP API #7 CWE-918]`

### 5.2 — GCP metadata service exposure
- **What:** If outbound HTTP exists, the metadata IP `169.254.169.254` MUST be unreachable from user-driven requests.
- **Grep:** `Grep "169\.254\.169\.254|metadata\.google\.internal" --type py -n` in `backend/`. Inspect each match. P0 if user input can drive the URL toward metadata.
- **Severity ceiling:** P0
- **Tag:** `[OWASP API #7 CWE-918]`

### 5.3 — Outbound third-party API URL safety
- **What:** Outbound third-party API URLs are constructed server-side from templated safe params, NOT user-templated (the path/query is server-built; user input only fills pre-validated fields).
- **Grep:** `Grep "https?://" --type py -n` in `backend/` for outbound base URLs; inspect each URL-construction site for user-controlled path/host segments.
- **Severity ceiling:** P1
- **Tag:** `[OWASP API #7 CWE-918]`

---

## Category 6 — Security Misconfiguration (OWASP A05, CWE-16)

### 6.1 — CORS fail-closed
- **What:** `backend/api/main.py:88-107`: `ALLOWED_ORIGINS` required (RuntimeError if missing), `*` rejected (RuntimeError if present).
- **Grep:** `Read backend/api/main.py` lines 85-110. Confirm both RuntimeError branches. P0 if either branch removed.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A05 CWE-942]`

### 6.2 — allow_credentials with origin allowlist
- **What:** `allow_credentials=True` only allowed with explicit origin allowlist (already true; verify).
- **Grep:** Same as 6.1; verify `allow_credentials=True` AND `allow_origins=_allowed_origins` (the explicit list).
- **Severity ceiling:** P0
- **Tag:** `[OWASP A05 CWE-942]`

### 6.3 — Cache-Control on authed responses
- **What:** Authed JSON responses include `Cache-Control: private, no-store`.
- **Grep:** `Grep "Cache-Control|cache_control" --type py -n -i` in `backend/api/`. P1 if any authed endpoint returns long-cache headers.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A05 CWE-525]`

### 6.4 — Error sanitization
- **What:** `_sanitized_500` in `main.py:110-137` is the global handler; no per-route handlers leak stack traces.
- **Grep:**
  - Verify `Read backend/api/main.py` lines 110-140 still matches the documented shape
  - `Grep "@app\.exception_handler" --type py -n` in `backend/api/` — confirm only the documented two handlers (StarletteHTTPException + Exception)
  - `Grep "traceback\.format_exc|exc_info=True.*response" --type py -n` in `backend/api/` — flag any path that puts a traceback into the response body
- **Severity ceiling:** P0
- **Tag:** `[OWASP A09 CWE-209]`

### 6.5 — FastAPI debug mode
- **What:** `FastAPI(debug=False)` in production. Look at `main.py:50`.
- **Grep:** `Grep "FastAPI\(" --type py -n` in `backend/`. P0 if any call passes `debug=True` unconditionally.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A05 CWE-489]`

---

## Category 7 — Secrets & Logging (OWASP A09, CWE-532)

### 7.1 — Secret-in-logs grep
- **What:** No secret-looking value appears in a `logger.*` call.
- **Grep:** `Grep "logger\.[a-z]+.*\b(THIRD_PARTY_API_KEY|Bearer|service.*account|sk_live|sk_test|stripe.*secret|db_password|GOOGLE_APPLICATION_CREDENTIALS)\b" --type py -n -i` in `backend/`. P0 for each match.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A09 CWE-532]`

### 7.2 — Token in error responses
- **What:** `_sanitized_500` does NOT include `Authorization` / token values in correlation-id payload.
- **Grep:** `Read backend/api/main.py` lines 110-140. Confirm response body is `{"error": ..., "correlation_id": ...}` ONLY — no request headers / token interpolated.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A09 CWE-209]`

### 7.3 — Secret Manager source
- **What:** `ensure_secrets()` in `main.py:46` loads from Secret Manager in production.
- **Grep:** `Read backend/api/main.py` line 46 and the `ensure_secrets` definition. Confirm it imports from `google.cloud.secretmanager` (or wraps it). P0 if hardcoded plaintext anywhere.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A05 CWE-798]`

### 7.4 — service-account.json gitignore
- **What:** `.gitignore` covers `service-account.json` AND the file is dev-only (not project owner key).
- **Grep:** `Grep "service-account" .gitignore`. P0 if missing. Verifying "not project owner" requires GCP-side inspection — out of scope here; defer to `security-gcp`.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A05 CWE-540]`

### 7.5 — Env-var dumps
- **What:** No handler returns `os.environ` or `dict(os.environ)`.
- **Grep:** `Grep "os\.environ|dict\(os\.environ" --type py -n` in `backend/`. For each, verify it's not exposed via a response or wide log.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A09 CWE-200]`

---

## Category 8 — Analytics Container (cross-cutting; backend/analytics/)

### 8.1 — Analytics auth posture
- **What:** `backend/analytics/auth.py` enforces shared-secret header (SCHEDULER_KEY) or stronger. MUST NOT trust `X-Forwarded-*` for auth.
- **Grep:**
  - `Read backend/analytics/auth.py` — confirm threat model
  - `Grep "X-Forwarded|x_forwarded" --type py -n` in `backend/analytics/` — P0 if used for auth decisions
- **Severity ceiling:** P0
- **Tag:** `[OWASP API #2 CWE-345]`

### 8.2 — Analytics rate-limit wiring
- **What:** `backend/analytics/rate_limit.py` is wired into `main.py` (mirror of api's slowapi).
- **Grep:** `Read backend/analytics/main.py` — confirm `rate_limit` is imported and middleware added.
- **Severity ceiling:** P1
- **Tag:** `[OWASP API #4 CWE-770]`

### 8.3 — No public-reachability assumption
- **What:** Analytics code does NOT include CORS-relaxed "dev mode" or `allow_origins=["*"]` shipped to production.
- **Grep:** `Grep "allow_origins|CORS" --type py -n` in `backend/analytics/`. P0 if any wildcard.
- **Severity ceiling:** P0
- **Tag:** `[OWASP A05 CWE-942]`

### 8.4 — Dev SCHEDULER_KEY suppression
- **What:** The dev-mode `SCHEDULER_KEY` placeholder is intentional (dev-only convenience; production injects the real value via Secret Manager).
- **Action:** Apply suppression from `SUPPRESSIONS.md` (id: `scheduler-key-dev-placeholder`). DO NOT report as a finding.

### 8.5 — Cross-tier replay
- **What:** If api and analytics share a token format, the analytics container MUST reject api-issued tokens (different audience / signing key).
- **Grep:** Compare token-validation code between `backend/api/auth.py` and `backend/analytics/auth.py`. P1 if same key/audience accepted.
- **Severity ceiling:** P1
- **Tag:** `[OWASP API #2 CWE-345]`

---

## Category 9 — Dependencies & Supply Chain (OWASP A06, CWE-1104)

### 9.1 — pip-audit emit
- **What:** Emit `pip-audit -r backend/api/requirements.txt` and `pip-audit -r backend/analytics/requirements.txt` scripts; user runs them.
- **Action:** Emit the two-line shell block in the output. P1 ceiling for findings; P0 only for known CVE matches when the user runs the script and reports back.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A06 CWE-1104]`

### 9.2 — Bandit emit + inline grep
- **What:** Emit `bandit -r backend/ -ll -ii` for the user. Skill itself greps the highest-impact rules:
  - **B102** `exec_used` — covered by 3.3
  - **B301** `pickle` — covered by 3.5
  - **B307** `eval` — covered by 3.3
  - **B502** `ssl_with_bad_version` — `Grep "ssl_version=ssl\.(SSLv2|SSLv3|TLSv1\b)" --type py -n` in `backend/`. P0.
  - **B503** `ssl_with_bad_defaults` — `Grep "ssl\.PROTOCOL_(SSLv2|SSLv3|TLSv1\b)" --type py -n`. P0.
  - **B608** `hardcoded_sql_expressions` — covered by 3.1
- **Severity ceiling:** P1 (P0 for direct CVE matches above)
- **Tag:** `[OWASP A06 CWE-1104]` (or specific CWE per rule)

### 9.3 — Known-bad ranges
- **What:** Diff pins against any user-supplied Python known-bad ranges. Placeholder until user provides.
- **Action:** Note in output: "no user-supplied known-bad range; add to `references/SUPPRESSIONS.md` when one becomes known."
- **Severity ceiling:** P0 if matched

---

## Webhook & Scheduler Hardening

### W.1 — Backend Stripe webhook signature (if any)
- **What:** If `backend/api/` has a Stripe webhook handler, signature is verified via `Stripe.webhooks.construct_event(payload_bytes, sig, secret)` with raw bytes.
- **Grep:** `Grep "stripe\.webhooks?|Stripe\.Webhook" --type py -n -i` in `backend/api/`. For each, verify raw-bytes signature check.
- **Severity ceiling:** P0
- **Tag:** `[OWASP API #2 CWE-345]`

### W.2 — Scheduler endpoint hardening
- **What:** Any `/sync-*` endpoint validates `SCHEDULER_KEY` before processing.
- **Grep:** `Grep "@router\.(get|post)\(['\"]/sync" --type py -n` in `backend/`. For each, verify the handler checks `SCHEDULER_KEY`.
- **Severity ceiling:** P0
- **Tag:** `[OWASP API #2 CWE-306]`

---

## Logic & Business Rules

### L.1 — GET handlers that mutate state
- **What:** `@router.get(...)` handlers MUST be safe (no DB writes, no side effects).
- **Grep:** `Grep "@router\.get" --type py -n` in `backend/api/`. For each, inspect handler body for `INSERT|UPDATE|DELETE|client\.query` writes.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A04 CWE-352]` (logic vulnerability surface)

### L.2 — Numeric input validation
- **What:** All numeric params reject negative + zero + out-of-range values.
- **Grep:** `Grep "Query\(\.\.\.|Query\(None" --type py -n` in `backend/api/`. For each numeric param, verify `ge=` / `gt=` / `le=` / `lt=` bounds.
- **Severity ceiling:** P2
- **Tag:** `[OWASP A04 CWE-20]`

### L.3 — Subscription cache race
- **What:** No path where a `subscriptionActive` mutation mid-request leaves a paying user blocked for the cache TTL.
- **Action:** If a known subscription-cache-coherence ticket exists and remains open, surface it as a P1 finding with the ticket cite rather than re-auditing the logic.
- **Severity ceiling:** P1
- **Tag:** `[OWASP A04 CWE-362]`

---

## Cross-references to sibling skills

- **Frontend / Next.js auth callbacks / Stripe webhook in Next** — `security-frontend`
- **GCP IAM, Cloud Run ingress, Firestore rules** — `security-gcp`
- **Per-PR diff review** — `/security-review`
- **Composition / dedup / snapshot diff** — the `security` orchestrator skill

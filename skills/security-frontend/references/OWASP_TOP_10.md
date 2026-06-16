# OWASP Top 10 (2021) — Tag Reference

Use these tags on findings. Full spec: https://owasp.org/Top10/

| Tag | Name | One-line | Common CWE |
|---|---|---|---|
| **A01** | Broken Access Control | Caller can act outside their permissions (IDOR, open redirect, missing authz). | CWE-200, CWE-201, CWE-352, CWE-601 |
| **A02** | Cryptographic Failures | Sensitive data exposed in transit / at rest / in client bundle. | CWE-200, CWE-540, CWE-922 |
| **A03** | Injection | XSS, SQL, command, template, NoSQL, LDAP. | CWE-79, CWE-89, CWE-94, CWE-1321 |
| **A04** | Insecure Design | Architectural flaws (race conditions, missing rate-limit). | CWE-770, CWE-841 |
| **A05** | Security Misconfiguration | Defaults left on, missing headers, loose CORS, verbose errors. | CWE-16, CWE-1021 |
| **A06** | Vulnerable & Outdated Components | Known-bad dependency versions. | CWE-1104, CWE-1357 |
| **A07** | Identification & Authentication Failures | Weak auth, CSRF, session fixation. | CWE-287, CWE-352, CWE-613 |
| **A08** | Software & Data Integrity Failures | Unsigned updates, missing SRI, untrusted deserialization. | CWE-353, CWE-502, CWE-829 |
| **A09** | Security Logging & Monitoring Failures | Tokens in logs, missing audit trail. | CWE-117, CWE-532 |
| **A10** | Server-Side Request Forgery (SSRF) | Server fetches user-controlled URL. | CWE-918 |

## When to use each tag

- A01 vs A07: A01 = wrong permission; A07 = wrong authentication
- A02 vs A09: A02 = exposure in transit/storage/bundle; A09 = exposure in logs
- A05 vs A06: A05 = config left wrong (headers, debug mode); A06 = old library with CVE
- A03 (XSS) vs A03 (SQLi): same tag, different CWE (CWE-79 vs CWE-89)

## Frontend-specific Top 10 mappings

| Frontend vector | OWASP tag | CWE |
|---|---|---|
| `dangerouslySetInnerHTML` with user input | A03 | CWE-79 |
| Missing CSP / loose CSP | A05 | CWE-1021 |
| Stripe `sk_*` in client | A02 | CWE-540 |
| Open redirect from `useSearchParams` | A01 | CWE-601 |
| Missing `noopener noreferrer` | A05 | CWE-1022 |
| Missing webhook signature check | A07 | CWE-345 |
| Bearer token in `localStorage` | A02 | CWE-922 |
| `next/image` `remotePatterns: ['**']` | A10 | CWE-918 |
| Prototype pollution via `Object.assign` | A03 | CWE-1321 |
| Missing OAuth `state` param check | A07 | CWE-352 |
| `'use server'` action with no auth | A01 | CWE-862 |
| Caret-range on `firebase` | A06 | CWE-1104 |

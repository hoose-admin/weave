# OWASP ASVS v4.0 — Sections this skill covers

The Application Security Verification Standard provides leveled requirements (L1/L2/L3). This skill targets **L1** by default (every web app), with L2 controls flagged where applicable.

Full spec: https://owasp.org/www-project-application-security-verification-standard/

| Section | Title | Coverage in this skill | Catalog refs |
|---|---|---|---|
| **V2** | Authentication | Firebase token verification, custom-claim handling, constant-time compares | 2.1, 2.2, 2.3 |
| **V3** | Session Management | Bearer-only, no cookies — N/A bulk of section; verify no cookie auth snuck in | 6.1, 6.2 |
| **V4** | Access Control | Router-factory coverage, BOLA, BFLA, mass assignment, BOPLA | 1.1–1.5 |
| **V5** | Validation, Sanitization, Encoding | All injection vectors (SQL, command, path, template, deserialization) | 3.1–3.8 |
| **V7** | Error Handling and Logging | _sanitized_500, secret-in-logs, log injection | 6.4, 7.1, 7.2, 3.7 |
| **V8** | Data Protection | Cache-Control on authed responses, env-var dumps, response sanitization | 6.3, 7.5 |
| **V9** | Communications | CORS, TLS posture (Bandit B501/B502/B503) | 6.1, 6.2, 9.2 |
| **V10** | Malicious Code | Out of scope — code review, not malicious-code detection |
| **V11** | Business Logic | GET-mutates, race conditions, numeric validation | L.1, L.2, L.3 |
| **V12** | Files and Resources | Path traversal, file upload | 3.4 |
| **V13** | API and Web Service | Rate-limit, pagination, max body, scheduler endpoint auth | 4.1–4.7, W.2 |
| **V14** | Configuration | Debug=False, dependency CVEs | 6.5, 9.1, 9.2 |

## L2 controls flagged by this skill

L2 means "applications dealing with sensitive data" — this application processes subscriber billing + user identity, so L2 is appropriate to aspire to.

L2 requirements above L1 that this skill checks:

- **V2.2.1** (L2): Anti-automation on auth endpoints → covered by API #4 rate-limit checks
- **V2.10.x** (L2): Service-account authentication via short-lived tokens → flagged in 7.4 (defers to `security-gcp` for the WIF check)
- **V4.1.5** (L2): Access-control failures fail-securely → covered by 2.1 (fail-closed verify_firebase_token)
- **V7.4.3** (L2): Logs don't contain sensitive data → covered by 7.1
- **V9.1.2** (L2): TLS to backend services → covered by Bandit B501/B502/B503 (9.2)
- **V13.2.1** (L2): JSON schema validation on inputs → covered by Pydantic models (audited inline)

## L3 (out of scope)

L3 is for "high-value applications" — military, healthcare, critical infrastructure. Not relevant here unless the threat model changes.

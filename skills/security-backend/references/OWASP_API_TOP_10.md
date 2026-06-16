# OWASP API Security Top 10 (2023) — Tag Reference

Use these tags on findings. Full spec: https://owasp.org/API-Security/editions/2023/en/0x00-header/

| Tag | Name | One-line | Common CWE |
|---|---|---|---|
| **API #1** | Broken Object-Level Authorization (BOLA) | Endpoint trusts caller's right to access an object referenced by ID/path param without verifying ownership. | CWE-639 |
| **API #2** | Broken Authentication | Token verification missing, weak, or bypassed. Subscription cache poisoning lives here. | CWE-287, CWE-345 |
| **API #3** | Broken Object Property-Level Authorization (BOPLA) | Property-level: user can read/write fields they shouldn't (mass assignment, excessive data exposure). | CWE-915, CWE-213 |
| **API #4** | Unrestricted Resource Consumption | No rate-limit, no payload cap, no pagination cap → DoS / cost-bomb. | CWE-770, CWE-400 |
| **API #5** | Broken Function-Level Authorization (BFLA) | Admin function reachable from user-tier auth. | CWE-285 |
| **API #6** | Unrestricted Access to Sensitive Business Flows | Bulk-action endpoints (signups, password reset, checkout) without throttling per business intent. | CWE-840 |
| **API #7** | Server-Side Request Forgery (SSRF) | User-controlled URL fetched by server → metadata service, internal LAN, dns rebinding. | CWE-918 |
| **API #8** | Security Misconfiguration | Defaults left on, debug=True, verbose errors, CORS too open, missing security headers. | CWE-16, CWE-209 |
| **API #9** | Improper Inventory Management | Old API versions / debug endpoints / internal routes still reachable. | CWE-1059 |
| **API #10** | Unsafe Consumption of APIs | Trust downstream third-party APIs blindly (no TLS verify, no schema check on response). | CWE-829 |

## When to use each tag

- BOLA vs BFLA: BOLA = wrong object (other user's data); BFLA = wrong function (admin endpoint as user)
- A03 vs API #4: A03 (injection) = malicious payload; API #4 = volumetric / resource-exhaustion
- API #2 vs A07: same family; API #2 is API-specific (token verification); A07 (Identification & Authentication Failures) is the broader Top 10 (2021) equivalent

## Cross-mapping to OWASP Top 10 (2021)

When a finding fits both lists, prefer the API-Top-10 tag (more specific). Cross-references:

| API Top 10 | Top 10 (2021) |
|---|---|
| API #1 BOLA | A01 Broken Access Control |
| API #2 Broken Auth | A07 ID & Auth Failures |
| API #3 BOPLA | A01 / A04 |
| API #4 Resource Consumption | A05 Misconfig (rate-limit absence) |
| API #5 BFLA | A01 |
| API #7 SSRF | A10 SSRF |
| API #8 Misconfig | A05 Misconfig |
| API #9 Inventory | A05 / A09 |
| API #10 Unsafe Consumption | A06 Vulnerable Components |

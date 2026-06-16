# Next.js 14 Security Headers — Canonical Reference

Drop-in `headers()` block for `next.config.js`. Tailored for a Firebase Auth + Stripe Checkout + TanStack Query + FastAPI-backend app (connecting against `*.googleapis.com` + the FastAPI backend domain).

Use this as the target state when auditing `next.config.js` per Category 4.1 in `CHECK_CATALOG.md`.

## Recommended `next.config.js` headers() block

```javascript
// next.config.js
const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // Scripts: self + Stripe + Firebase Auth. Avoid 'unsafe-eval'.
      // 'unsafe-inline' is required by Next.js for inline scripts until
      // you adopt nonces — track as a P2 follow-up.
      "script-src 'self' 'unsafe-inline' https://js.stripe.com https://*.firebaseapp.com",
      // Styles: 'unsafe-inline' is required for Tailwind / styled-jsx today.
      "style-src 'self' 'unsafe-inline'",
      // Connect: backend API + Firebase + Stripe + Google APIs (Firestore, Identity Platform)
      "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://identitytoolkit.googleapis.com https://api.stripe.com https://m.stripe.com",
      // Images: self + Stripe + Firebase + signed image hosts (next/image)
      "img-src 'self' data: blob: https://*.googleusercontent.com https://*.stripe.com",
      // Fonts
      "font-src 'self' data:",
      // Frames: Stripe Checkout, Firebase Auth iframe
      "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://*.firebaseapp.com",
      // Lock down: no frame-ancestors (clickjacking defense)
      "frame-ancestors 'none'",
      // Lock down: only forms POST to self
      "form-action 'self'",
      // Lock down: base URI cannot be hijacked
      "base-uri 'self'",
      // Aspirational: require Trusted Types for any future eval/innerHTML
      // "require-trusted-types-for 'script'",
    ].join('; '),
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'X-Frame-Options',
    value: 'DENY',  // belt-and-suspenders with CSP frame-ancestors
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value: [
      'camera=()',
      'microphone=()',
      'geolocation=()',
      'payment=(self "https://js.stripe.com")',
      'usb=()',
      'magnetometer=()',
      'accelerometer=()',
      'gyroscope=()',
    ].join(', '),
  },
  {
    key: 'Cross-Origin-Opener-Policy',
    value: 'same-origin',
  },
  {
    key: 'Cross-Origin-Resource-Policy',
    value: 'same-origin',
  },
  // COEP omitted intentionally — `require-corp` breaks Stripe + Firebase
  // iframes today. Revisit when both ecosystems set CORP headers correctly.
];

module.exports = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};
```

## Severity ranking for missing / wrong headers

| Header | Missing | Loose |
|---|---|---|
| Content-Security-Policy | P2 | P1 (if `unsafe-eval` or `*` source) |
| Strict-Transport-Security | P1 | — |
| X-Frame-Options / frame-ancestors | P1 | — |
| X-Content-Type-Options | P2 | — |
| Referrer-Policy | P2 | — |
| Permissions-Policy | P2 | — |
| COOP | P2 | — |
| CORP | P2 | — |
| COEP | (intentionally omitted today) | — |

## Compatibility notes

- **Stripe Checkout** requires `js.stripe.com` in `script-src`, `hooks.stripe.com` in `frame-src`, `api.stripe.com` in `connect-src`. The payment surface fails silently if any of these are blocked.
- **Firebase Auth iframe** requires `*.firebaseapp.com` in both `script-src` AND `frame-src` for the OAuth redirect flow.
- **Identity Platform** uses `identitytoolkit.googleapis.com` for token-exchange — must be in `connect-src`.
- **TanStack Query** has no special CSP requirements.
- **next/image** with remote hosts requires those hosts in `img-src` AND in `images.remotePatterns` (separate concern — see Category 7.1).
- **CORS at the API tier** is enforced by FastAPI (`backend/api/main.py`), not by these headers. These are response headers; CORS is a preflight protocol.

## What this skill checks

- Header PRESENCE per the table above (P2 if missing entirely)
- Header VALUE LOOSENESS — flagged P1 if `'unsafe-eval'`, `'*'` (open source), or `frame-ancestors *`
- Stripe / Firebase domains MUST appear in the connect/script/frame allowlists if those integrations are wired (cross-ref `frontend/lib/firebase.ts`, `frontend/lib/identity-platform.ts`, `frontend/app/api/stripe/`)

## What this skill does NOT do

- Run a live browser to test the policy. Static audit only.
- Suggest a specific nonce-based CSP (requires per-request server-side middleware support). Recommend adopting nonces as a P2 follow-up.
- Test the headers against tools like https://securityheaders.com — that's a separate user step. Emit the URL as a recommendation in the report.

## References

- Next.js Content Security Policy guide — https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy
- MDN CSP — https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP
- MDN HSTS — https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security
- MDN Permissions-Policy — https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Permissions-Policy
- OWASP Secure Headers Project — https://owasp.org/www-project-secure-headers/
- https://securityheaders.com — third-party scanner (user-run)

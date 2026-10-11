# StayLoop Security Reference

Scope: the ACTUAL implemented controls. Anything not listed here is not
claimed. Legal/privacy compliance statements are out of scope — see the note
at the end.

## 1. Authentication

| Control | Implementation |
|---|---|
| Password storage | scrypt (64-byte key, 16-byte random salt), `timingSafeEqual` compare — `src/lib/auth.ts` |
| Session tokens | HMAC-SHA256 signed compact tokens, 7-day TTL, payload `{userId, hotelId, role, vtv, mcp}` |
| Session revocation | Per-user `tokenVersion`; DB re-read on EVERY request; bumped on logout, password change/reset |
| Account lockout | 5 failures → progressive 15 m → 30 m → 60 m → 24 h (DB-backed, shared across instances) |
| Per-IP throttle | 50 attempts / 25 failures per 15 min (DB `AuthAttempt`) + 60/min in-memory damping |
| Email verification | 256-bit token, SHA-256-hashed storage, 24 h TTL, one-time atomic consume, anti-enumeration resend; login gate optional via `REQUIRE_EMAIL_VERIFICATION` |
| Password reset | 256-bit hashed token, 1 h TTL, one-time use, previous tokens invalidated, sessions revoked (`tokenVersion++`), lockout cleared, audited |
| CSRF | Origin/Referer allowlist + double-submit cookie, constant-time compare, enforced inside `requireAuth` for every mutating route |
| Cookies | `HttpOnly; Secure; SameSite=None; Partitioned` over HTTPS (CHIPS), `Lax` over plain HTTP dev |
| Bearer fallback | Login response also carries the session token for cookie-blocked embedded contexts — documented XSS trade-off; revocation still applies. Cookie mode is primary. |

## 2. Authorization

- 8 roles (SUPER_ADMIN … HOTEL_STAFF) × ~40 permissions in
  `src/lib/permissions.ts`; every protected route calls `requirePermission()`.
- Vertical escalation: super-admin endpoints reject hotel users and
  anonymous callers (tested).
- Horizontal isolation: `hotelId` is ALWAYS taken from the DB-loaded session
  user, never from params/body/headers; foreign resource access returns 404
  (indistinguishable from non-existent). Cross-tenant tests cover customers,
  visits, coupons, segments, campaigns, integrations, audit logs, jobs.
- `mustChangePassword` sessions are restricted to `/api/auth/me`,
  `/api/auth/logout`, `/api/profile`.

## 3. Input handling & injection

- All request bodies pass Zod schemas (`src/lib/validation.ts`); 1 MB JSON cap.
- Prisma parameterized queries only — no raw SQL string building anywhere.
- CSV: RFC-4180 parser, size/row caps, formula-injection neutralization
  (`=`, `+`, `-`, `@` prefixes), preview==commit import semantics.
- Public QR join/feedback derive `hotelId` server-side from the scanned code —
  never from the payload.
- Webhooks: HMAC-SHA256 signature + timestamp replay window (±5 min),
  idempotent event handling, fail-closed (503) when the secret is unset.

## 4. Rate limiting

- Distributed Redis fixed-window limiter (`REDIS_URL`, atomic Lua script) with
  automatic per-instance fallback when Redis is absent/unreachable — the
  fallback is a documented single-instance limitation, not a silent failure.
- Limits: login 60/min/IP (+DB throttle), registration 5/h/IP, verification
  resend 5/h/IP + 3/h/email, forgot-password 5/h/IP + 3/h/email, reset 10/min/IP,
  public join 10/min/IP + 3/min/phone, public feedback 6/min/IP + 3/h/phone,
  QR 60/min/IP, webhooks 300/min/IP, exports 100 concurrent queued.
- Responses: `429` with `Retry-After`.

## 5. Transport & headers

- HSTS 2 years (`includeSubDomains`), CSP with `default-src 'self'`,
  `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`;
  `frame-ancestors` defaults to `'self'` in production (configurable via
  `EMBED_FRAME_ANCESTORS`), `nosniff`, strict `Referrer-Policy`,
  `Permissions-Policy` denies camera/mic/geolocation/payment.
- `script-src 'unsafe-inline'` remains a known, documented trade-off of the
  Next.js App Router runtime; a nonce-based CSP would require a custom
  document rendering layer (roadmap).

## 6. CORS

- Same-origin by default. Cross-origin browser access only for exact origins
  listed in `TRUSTED_ORIGINS` (middleware). Unknown-origin preflights are
  rejected `403`; no wildcard ever combines with credentials.

## 7. Secrets management

- All credentials come from environment variables; startup validation fails
  closed (missing/weak/placeholder values reject production boot).
- Previously-shipped dev secrets are in the rejection blocklist and MUST be
  rotated — procedure in `docs/SECRET_ROTATION.md`.
- Integration credentials are AES-256-GCM encrypted at rest with tenant-bound
  AAD; decrypt only server-side when calling providers.
- Secret scanner (`scripts/scan-secrets.ts`) runs in CI; blocks merges on
  findings (12 rule families + forbidden tracked files).

## 8. Audit & logging

- `AuditLog` records logins/failures/lockouts, password changes and resets,
  email verification, RBAC-relevant changes, campaign create/send/queue,
  coupon redemption, loyalty adjustments, exports, CSRF blocks, webhook
  rejections, admin actions — with secret-scrubbing metadata.
- Structured JSON application logs redact sensitive keys; request correlation
  via `x-request-id`.

## 9. Data protection & privacy posture

- Customer deletion, per-channel consent capture/withdrawal, opt-out, and
  personal-data export (CSV via `/api/export/customers`, JSON per customer)
  are implemented. Retention: export files expire after 24 h; security tokens
  are purged automatically; audit retention follows DB policy (see
  `docs/DATABASE.md`).
- Consent timestamps, source, and channel are recorded; marketing sends stop
  immediately after withdrawal (consent re-read before every provider call).
- **Not claimed**: GDPR/DPDP certification or any legal compliance. A formal
  legal review (DPA, records of processing, breach-notification workflow) is
  REQUIRED before operating on EU/India personal data.

## 10. Known accepted risks (as of Phase 7)

| ID | Risk | Mitigation / rationale |
|---|---|---|
| R-1 | Bearer session token readable by XSS in the embedded-fallback flow | Primary flow is HttpOnly cookies; revocation via tokenVersion; documented; removal tracked as roadmap |
| R-2 | `unsafe-inline` script CSP | Required by Next.js runtime without nonce middleware; all other CSP directives locked down |
| R-3 | In-memory rate-limit fallback without Redis | Explicit status in `/api/health`; authoritative auth throttling is DB-backed regardless |
| R-4 | Single shared `AUTH_SECRET` for sessions + export-file tokens | Rotation procedure documented; HMAC domain separation (`export:<id>` prefix) |
| R-5 | No MFA despite schema fields | Documented gap; roadmap item (TOTP), not silently claimed |

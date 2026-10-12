# Security findings — 2026-10-12 addendum

Historical detailed review: `audit/SECURITY_FINDINGS.md` (older audit; dates/results differ). Findings below are for this checkout.

| ID / severity / locations | Reproduction, root cause, fix, regression, residual risk |
|---|---|
| FUNC-001 / High / `src/lib/custom-roles.ts:65-98`, `src/lib/api-helpers.ts:240`, `src/lib/permissions.ts:460-483` | Existing static-only `requirePermission` ignored custom assignments. Added fresh same-tenant role resolution to every `requireAuth` result, no cross-request cache; malformed/inactive/foreign role ignored. `bun test tests/custom-role-resolution.test.ts`: 3 PASS mocked-delegate tests. DB-backed `tests/custom-role-api.test.ts` BLOCKED; no production claim. |
| ROLE-002 / High / `src/lib/custom-roles.ts:21-29,44-60,164-175` | Prior validator allowed owner to mint `STAFF_MANAGE`, `BILL_VOID`, `CUSTOM_ROLE_MANAGE` and similar sensitive rights via custom role. New reserved allowlist is applied both at create/update/assign and runtime resolution (including old stored roles); active target and same hotel required. Regression: mocked-delegate test PASS. Historical custom roles with reserved grants lose those grants; migrate users needing them to supervised system roles. Full cross-tenant integration BLOCKED. |
| SEC-007 / Low / `src/lib/payment-link-limit.ts`, `src/app/api/pay/[token]/*` | Public read/checkout/verify had no rate limiter. Limits: 60/10/30 requests per IP per minute respectively, 429 with Retry-After; keys use proxy-derived IP. `bun test tests/payment-link-limit.test.ts`: 1 PASS. Multi-instance Redis behavior BLOCKED; without Redis limiter is per-process. |
| PAY-001 / High / `src/app/api/pay/[token]/verify/route.ts` final update | Payment capture succeeds, then `paymentLink.update(...).catch(() => undefined)` can return 200 while link state stays ACTIVE. Source trace only; no gateway sandbox or transaction test. NOT FIXED: needs transactional reconciliation with provider-capture path, safe retry semantics and tests before release. |
| DEP-002 / High / `bun.lock` | `bun audit --audit-level=high`: 26 high advisories. No blanket upgrade or unreviewed dependency changes applied. Dependency triage required. |

Authentication/MFA, all 204 routes, browser navigation, distributed revocation and payment provider signatures have **not** been dynamically audited this pass. Existing historical findings must not be treated as current PASS.

---

# Historical findings (2026-10-11; superseded for status by addendum above)

# Security Findings — StayLoop audit (2026-10-11)

Branch: `arena/4731a2f4-hotal` · Base: `b398b81` (main)

Method: static source review of the paths listed below, plus automated inventory
(`audit/ROUTE_INVENTORY.md`, `audit/ROLE_PERMISSION_MATRIX.md`), a secret scan, and a production
dependency audit. **Dynamic exploitation against a running server was not possible** in this sandbox
(the Prisma query engine binary is not downloadable; see `TEST_RESULTS.md`). Confidence levels reflect that.

| ID | Title | Severity | Confidence | Status |
|---|---|---|---|---|
| SEC-001 | Admin can suspend, demote, or revoke the HOTEL_OWNER | High | High (source + permission table) | **Fixed** |
| SEC-002 | Superadmin guard trusted the signed role claim, not the DB role | Medium | High | **Fixed** (defense in depth) |
| SEC-003 | *(unused — ID reserved and not assigned to a confirmed finding)* | — | — | — |
| SEC-004 | `isTest()` ignored `NODE_ENV=production` | Low | High | **Fixed** (startup guard already blocks it) |
| SEC-005 | JSON body cap enforced only via `Content-Length` | Medium | High (source); DoS not reproduced | **Fixed** |
| SEC-006 | Logout had no CSRF check (logout-CSRF / forced session revocation) | Low–Medium | High | **Fixed** |
| SEC-007 | Unauthenticated payment-link routes have no rate limit | Low | High | Open (documented) |
| SEC-008 | Bearer tokens accepted on every route alongside cookies | Informational | High | Accepted (documented) |
| FIN-001 | Razorpay restaurant webhook drops captured payments on allocation error | High | High (source) | **Fixed** |

---

## SEC-001 — Admin can suspend, demote, or revoke the HOTEL_OWNER
- **Feature:** Staff account management (`PATCH /api/staff/[id]`)
- **Files:** `src/app/api/staff/[id]/route.ts`, `src/lib/permissions.ts` (`ROLE_PERMISSIONS`)
- **Preconditions / roles:** Any HOTEL_ADMIN (holds `STAFF_MANAGE`). HOTEL_OWNER is the target.
- **Root cause:** `STAFF_MANAGE` is granted to both HOTEL_OWNER and HOTEL_ADMIN. The route checked the
  permission and the last-admin count, but never compared the actor's rank with the target's. The
  last-admin guard only stops a hotel from having zero admins; it does not protect the owner.
- **Reproduction (source):** An admin sends `PATCH /api/staff/<ownerId>` with `{ "deactivate": true }`.
  The old path set `status: SUSPENDED` and bumped `tokenVersion` on the owner, as long as another admin remained.
- **Expected:** Only the owner may change the owner account. **Actual (before fix):** an admin could.
- **Impact:** A compromised or malicious admin could lock the account holder out of their own tenant and
  keep control, which is a vertical privilege problem inside the tenant.
- **Fix:** Added pure guard `canActOnStaffTarget(actorRole, targetRole)` in `src/lib/staff-guards.ts`.
  The route now calls it immediately after loading the target, before any mutation, and returns 403 for an admin
  acting on an owner. Peer admin-on-admin and admin-on-staff behavior is unchanged.
- **Regression test:** `tests/audit-2026-regressions.test.ts` → "SEC-001 staff hierarchy guard" (4 tests).
  Against the original code the source-wiring test **fails**; with the fix it **passes**.

## SEC-002 — Superadmin guard trusted the token's role claim
- **Files:** `src/lib/api-helpers.ts` (`requireSuperAdminSession`)
- **Root cause:** The guard checked `session.role` (from the signed token) and then the user's status,
  token version, and password/MFA flags. It did not re-read the role from the database. Requests
  authenticated by a token issued before a demotion stayed superadmin-authorized until the token expired,
  unless something else bumped `tokenVersion`.
- **Fix:** The guard now selects `role` and returns 403 unless the database role is `SUPER_ADMIN`.
  `requireAuth` already takes its role from the database, so this aligns the two paths.
- **Regression test:** Source-level coverage is limited here. Behavioral coverage requires the DB suite (BLOCKED).

## SEC-004 — `isTest()` returned true in production when `STAYLOOP_TEST=1`
- **Files:** `src/lib/config.ts`; consumers: `src/app/api/test/mock-emails/route.ts`, `src/lib/saas/backup.ts`
- **Root cause:** `isTest()` was `NODE_ENV === "test" || STAYLOOP_TEST === "1"` with no production check.
- **Mitigation already present:** `validateExtendedEnv()` (`src/lib/env.ts`) rejects `STAYLOOP_TEST`
  and `NODE_ENV=test` in production, and `src/instrumentation.ts` throws at boot, so the server refuses to start.
  This finding is therefore a defense-in-depth gap, not a live exposure.
- **Fix:** `isTest()` returns false whenever `isProduction()` is true.
- **Regression test:** "SEC-004 isTest() is never true in production".

## SEC-005 — JSON body size cap enforced only via `Content-Length`
- **Files:** original `src/lib/api-helpers.ts` (`readJson`); now `src/lib/body.ts`
- **Root cause:** The 1 MB cap was checked only against the declared `Content-Length`. A chunked or
  length-less request body was read fully by `req.json()` with no limit, so memory use was unbounded per request.
- **Fix:** `readBodyCapped` streams the body, counts bytes received, cancels the reader and returns null
  past 1 MB, and still rejects a declared oversize length up front. `readJson` is now an alias of
  `readJsonCapped`, so every existing caller gets the bounded read with no signature change.
- **Caveat:** Reproduction (sending a large chunked body to a running server and watching RSS) was NOT run.
  The fix is verified at the function level only.
- **Regression tests:** "SEC-005 bounded JSON body reads" (5 tests, including a chunked stream with no `Content-Length`).

## SEC-006 — Logout had no CSRF check
- **Files:** `src/app/api/auth/logout/route.ts`
- **Root cause:** `POST /api/auth/logout` bumps the user's `tokenVersion`, which revokes every session of
  that user. It did not call `assertCsrf`, unlike every other state-changing route. In production the session
  cookie is `SameSite=None; Secure; Partitioned`, so browsers send it on cross-site POSTs. Any third-party page
  could therefore log a signed-in user out of every device.
- **Fix:** The route calls `assertCsrf` before revoking. Cross-site Origin/Referer is rejected with 403 and
  nothing is revoked. A legitimate logout from the app is unaffected: `src/lib/api-client.ts` already sends
  `x-csrf-token` on mutations, and `src/app/page.tsx` logs out through that client.
- **Regression tests:** "SEC-006 logout is CSRF-protected" (2 tests; the cross-origin case is behavioral at the
  `assertCsrf` level, and the wiring check is source-level).

## SEC-007 — Unauthenticated payment-link routes have no rate limit (open)
- **Files:** `src/app/api/pay/[token]/route.ts` (GET), `src/app/api/pay/[token]/checkout/route.ts` (POST),
  `src/app/api/pay/[token]/verify/route.ts` (POST)
- **Observation:** None of the three calls `checkRateLimit`. Checkout creates a gateway order per call. The link
  token is high entropy, so this is an abuse / cost issue, not a guessing attack.
- **Mitigating checks confirmed:** checkout takes the amount from `link.amountMinor` (never from the client),
  and verify checks the HMAC signature before allocating.
- **Status:** Not fixed in this pass. Recommendation: add a per-IP and per-token `checkRateLimit`
  (same pattern as `public/feedback`). Low priority.

## SEC-008 — Bearer tokens accepted on every route (informational, accepted)
- **Files:** `src/lib/auth.ts` (`getSessionAuth`)
- **Observation:** `Authorization: Bearer` is accepted on all authenticated routes, and CSRF's double-submit
  check is skipped for bearer sessions (the Origin check still applies). This is documented as the iframe
  fallback. A token stolen through XSS is as usable as a cookie. The strict nonce-based CSP in `src/proxy.ts`
  is the main control against that. Accepted as a documented design choice.

## FIN-001 — Razorpay restaurant webhook drops captured payments on allocation error
- **Feature:** Restaurant bill payments via Razorpay (`POST /api/webhooks/razorpay-restaurant`)
- **Files:** `src/app/api/webhooks/razorpay-restaurant/route.ts`; allocation in `src/lib/billing.ts` (`recordGatewayCapture`)
- **Root cause:** The handler writes a dedupe row (`RestaurantWebhookEvent`, unique on `eventId`) before
  allocating money, and marks it `PROCESSED`. `recordGatewayCapture` converts only P2002 (unique violation) into
  `ok: true`. Any other failure, such as a DB timeout or the "Bill changed during capture" conflict, is re-thrown.
  The re-throw skipped the cleanup that the `!result.ok` branch performs. The surviving row made Razorpay's retry
  return `{ duplicate: true }` with 200, so the retry was ignored and the captured payment was never allocated.
- **Impact:** A customer's captured money is not recorded against the bill. It would need manual reconciliation
  and is easy to miss.
- **Fix:** Wrap `recordGatewayCapture` in try/catch. On exception, delete the dedupe row for that `eventId`
  and re-throw, so the provider retries. Allocation stays exactly-once because the `gatewayPaymentId` unique
  fence inside `recordGatewayCapture` is unchanged.
- **Regression test:** "FIN-001 Razorpay webhook releases dedupe fence on allocation failure" (static assertion
  on the try/catch/cleanup/re-throw order). Confirmed to **fail** on the original code. The behavioral test (inject
  a DB error, then retry, then check allocation) needs the DB suite (BLOCKED).

---

## Checked and found sound (no finding)
- Password hashing: scrypt, N=2^17 with a random 16-byte salt per hash; legacy hashes rehash on login (`src/lib/auth.ts`).
- Session tokens: HMAC-SHA256 with `timingSafeEqual`, expiry checked, malformed cookies handled without a 500 (`safeDecodeCookie`).
- Revocation: per-user `tokenVersion`, bumped on logout, password reset, password change, staff deactivation, custom-role assignment, and force-logout.
- `requireAuth` (`src/lib/api-helpers.ts`) re-reads the user from the DB on every request: status, tenant status, token version, forced password change, MFA policy, subscription state, maintenance mode.
- Secrets: `AUTH_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, and `ADMIN_BOOTSTRAP_SECRET` are required in production (fail-closed at startup). Placeholder values are rejected. The dev-only fallback is a generated key, not a hardcoded one.
- Superadmin bootstrap (`POST /api/super-admin/bootstrap`): fail-closed without a secret, timing-safe comparison, one-time (409 once a superadmin exists), rate-limited.
- Test-only endpoint `/api/test/mock-emails`: gated by `isTest()`, which is now production-safe (SEC-004).
- Webhook verification (`src/lib/webhook-verify.ts`): raw-body HMAC, constant-time compare, 5-minute replay window, secret never accepted from a query string.
- Payment verification (`pay/[token]/verify`, `restaurant-payments/verify`): signature checked before allocation, amount bound to the intent, link state checked.
- Payment-link checkout takes the amount from the stored link, not from the client.
- CSRF (`src/lib/csrf.ts`): Origin/Referer host match plus double-submit cookie for cookie sessions.
- CSP: nonce-based scripts (`src/proxy.ts`); `unsafe-eval` only in dev; `object-src 'none'`, `frame-ancestors` explicit in production.
- Caddy sets HSTS, `nosniff`, and Referrer-Policy and removes `X-Frame-Options` (replaced by CSP `frame-ancestors`).
- Staff PATCH: the target is looked up with `hotelId` scoping before any mutation (cross-tenant IDs return 404).
- `menu/items/[id]` PATCH: tenant-scoped `findFirst` before the update (the later `findUnique` is redundant, not a leak).
- Secret scan (`scripts/scan-secrets.ts`): clean.
- Production dependency audit (`npm audit --omit=dev --audit-level=high`): 0 vulnerabilities.

## Not audited in depth (see REMAINING_RISKS.md)
Customer CSV import/export, consent/opt-out, campaign sending, inventory and POS arithmetic, tenant-isolation
of every `[id]` route, file upload/download, AI endpoints, and the SaaS billing webhook body handling. These
were covered only by the automated inventory, not by line-by-line handler review.

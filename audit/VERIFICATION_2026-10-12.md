# Bug sweep + feature verification — 2026-10-12

Companion to `audit/BUG_SWEEP_2026-10.md`. This pass re-verified the whole
product end-to-end and found three additional contract-level defects.

**How it was verified**

- Full test suite: `bun run test` — **469 tests, all passing** (was 464/466;
  the two historical failures were one sandbox timeout and one stale
  expectation, both now resolved — see below).
- Five HTTP probes over a seeded, running server (kept in the repo so they can
  be re-run: `scripts/verify/`, see its README):
  contract sweep 87/87 · full product journey 33/33 · public pages 9/9 ·
  integration features 26/26 · super-admin console 24/24.
- Malformed-input fuzz: 343 requests across 49 mutation endpoints — zero 5xx.
- Static sweeps: 204 API routes, every route with a mutation verb checked for
  an auth guard (the 22 without one are the intentional public/auth/webhook
  endpoints, all HMAC- or token-gated), zero `TODO`/`FIXME` markers left.

**Environment note.** Native Prisma engines are unreachable in this sandbox, so
`prisma db push`/`generate` run through a WASM-schema variant
(`prisma.config.ts`, `prisma/.tmp-schema-wasm.prisma`, plus a local patch of the
generated client that injects the libSQL adapter). These are sandbox-only and
are not part of the product; nothing in `src/` depends on them.

---

## BUG-11 — Reservations reported malformed input as a booking conflict

**Severity:** Medium (API contract / UI behaviour)

**Where:** `src/lib/reservations.ts`, `src/app/api/reservations/route.ts`

**What:** every validation failure was thrown as `ReservationConflictError`
and answered `409 SLOT_CONFLICT`. A body with an ISO `date`, a non-`HH:MM`
`startTime` or a non-positive `partySize` therefore looked identical to "that
table is already taken", so a booking UI could not tell the guest to fix the
time — it would show a double-booking conflict instead.

**Evidence:** `POST /api/reservations {date:"2031-01-15T19:30:00Z", startTime:"19:30"}` → `409` `"date must be YYYY-MM-DD (tenant-local)."` (before) → `422 VALIDATION_ERROR` (after), reported by `scripts/verify/route-sweep.ts`.

**Fix:** new `ReservationValidationError` for shape/type problems, mapped to
`422 VALIDATION_ERROR` by the route. Genuine availability/policy conflicts
(overlapping slot, per-table capacity, party above the tenant maximum,
reservations switched off, unknown table) still return `409 SLOT_CONFLICT`, as
`tests/phase16-operations.test.ts` documents.

---

## BUG-12 — A wallet pass could not be revoked from its issue response

**Severity:** Medium (API usability)

**Where:** `src/lib/ai/wallet.ts` (`WalletPassView`, `toView`)

**What:** `POST /api/wallet/passes` returned the pass view without the row
`id`, but `POST /api/wallet/passes/[id]/revoke` requires exactly that id. A
client that had just issued a pass could not revoke it without first calling
`GET /api/wallet/passes` — the repository's own integration test worked around
the gap the same way.

**Evidence:** issue (201) → revoke using the returned id → `404` (the URL
contained `undefined`). After the fix the probe does issue → revoke with no
extra call: `201` → `200`.

**Fix:** `id` is part of `WalletPassView` and of `toView`. A sweep of every
other create endpoint that has `[id]` children (cash sessions, promotions,
tax rules, experiments, privacy requests, API keys, …) showed they all already
return the identifier.

---

## BUG-13 — Custom-role validation answered 400, not 422

**Severity:** Low (API contract consistency)

**Where:** `src/lib/custom-roles.ts` (`createCustomRole`)

**What:** a reserved/ungrantable permission (e.g. `SUPER_ADMIN_ACCESS`) was
rejected with the handler's `400` fallback, while the same route returns `422`
for every other invalid payload (missing name, non-array permissions) and the
sibling `PATCH /api/custom-roles/[id]` returns `422` for the same
permission-validation failure.

**Fix:** the validation result now carries `status: 422`.
`tests/phase17-enterprise.test.ts` (which always expected 422) passes 12/12;
`tests/custom-role-api.test.ts` had pinned the old 400 for the identical case
and was updated — it was the only place in the repository asserting 400 there.

---

## Test-infrastructure — phase 11 could never pass under the runner

`tests/phase11-scheduler.test.ts` spawns the Prisma CLI inside one of its tests
(≈60 s on a cold cache), which exceeded Bun's 30 s default; the suite failed as
`(fail) (unnamed) [30015ms]` with the misleading message "prisma db push
failed". The runner now gives phase 11 the same 120 s allowance as the other
long files. Verified: **4/4**.

---

## Feature verification results

| Area | What was exercised | Result |
| --- | --- | --- |
| Auth & session | login/logout, CSRF cookie↔header, sessions, MFA TOTP (incl. replay fence), password change, verification, lockout | ✅ |
| RBAC & tenancy | staff/admin permission denials, super-admin gate, cross-tenant 404s, anonymous 401s, forged claims | ✅ |
| CRM | customers CRUD, consent, visits, timeline, lead events, scoring, follow-ups, segments (+ manual membership), CSV import/export | ✅ |
| Loyalty | accounts, ledgers, manual adjust, redemption rules, QR codes (menu/feedback/loyalty), referrals, coupons, promotions | ✅ |
| Restaurant ops | menu, tables + QR, sessions, orders (staff & public), KDS lifecycle, bills, reservations, inventory (ingredients, recipes, counts, purchase orders), attendance, shifts, branches | ✅ |
| POS & payments | cash/UPI/card split + partial payments, overpay refusal, receipts, cash sessions, tax rules, sales reports, leaderboard, payment links + public pay page + server-side verify | ✅ |
| Marketing | campaigns (segment + test send + analytics), automations, journeys, templates, feedback, notifications, analytics | ✅ |
| AI (Phase 18) | settings flags, voice cart parsing (staff + public), recommendations, forecasting honesty, wallet passes with honest `BLOCKED_PROVIDER_ACCESS` | ✅ |
| Enterprise (Phase 17) | custom roles, white-label branding + domain claim, outbound webhooks (redirects dead-lettered), A/B experiments, privacy requests, refunds (super-admin only), benchmarking honesty, franchise, API keys + `/api/v1` | ✅ |
| Platform console | super-admin stats, hotels, plans, subscriptions, flags, security, audit, billing, usage, KPIs, backups, coupons, templates, settings, health, secret rotations, support, refunds | ✅ |
| Public surface | QR landing pages, public menu JSON, guest feedback (rate-limited), public orders (idempotent), payment pages | ✅ |
| Suite | `bun run test` | **469/469** |

**Known non-issues confirmed during this pass**

- `GET /api/health` → 503 with `worker: "stale"` when `scripts/worker.ts` is
  not running: correct readiness semantics (fail closed), not a defect.
- Signatures/input probes that used the wrong field names (menu `priceMinor`
  in paise, uppercase inventory units, `startTime`, `messageTemplate`,
  `orderAmount`, `?customerId=`) are documented contracts, not bugs.

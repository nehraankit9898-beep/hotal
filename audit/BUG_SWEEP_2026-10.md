# Bug sweep — October 2026

Scope: find real, reproducible defects that were **not** already recorded in
the 2026 audit (`audit/FUNCTIONAL_BUGS.md`, `audit/SECURITY_FINDINGS.md`,
`audit/REMAINING_RISKS.md`). Every finding below was reproduced end-to-end on
the unfixed code (HTTP calls against the dev server plus the real job code),
fixed with a root-cause change and covered by regression tests.

| ID | Severity | Area | Summary |
|----|----------|------|---------|
| BUG-1 | High | Reports | Daily sales report and owner daily email used a 36-hour, timezone-blind "day" |
| BUG-2 | High | Billing | Promotions restricted to days of the week never applied |
| BUG-3 | High | Privacy / consent | Bill thank-you + review email sent to customers who replied STOP |
| BUG-4 | Medium | Security (SSRF) | Outbound webhooks followed redirects; production accepted internal hosts |
| BUG-5 | Medium | Reservations | A cancelled / no-show reservation blocked its table slot forever |
| BUG-6 | Medium | Inventory | Receiving a PO with the same ingredient on two lines stocked only one line |
| BUG-7 | Medium | Test infra / CI | Two suites never ran, four could never pass, and the runner itself caused the dev-server "wedge" |
| BUG-8 | High | Platform ops | Super Admin backups API route was never committed (`.gitignore`) — Backups page 404 |
| BUG-9 | Low | AI chatbot | WhatsApp webhook `replies` diagnostics always empty — the chatbot E2E suite could never pass |
| BUG-10 | High | RBAC / build health | Import cycle made `@/lib/permissions` un-loadable as an entry module — `tests/unit.test.ts` (and `bun run test`) died before a single assertion |

---

## BUG-1 — "Local day" window was 12:00 UTC → 23:59 UTC next day

**Where:** `localDayBounds` in `src/app/api/reports/sales/route.ts` and an
identical copy in `src/lib/retention.ts` (`computeDayReport`, the emailed owner
daily report).

**What:** the helper computed a "timezone offset" from the calendar *date*
only (`Date.UTC(y, m, d) − instant`), not from the wall-clock time. For every
timezone the window became `[D 12:00Z, D+1 23:59Z)` — 36 hours.

**Impact:** for an Indian restaurant the "12 Oct" report missed everything
before 17:30 IST and included all of 13 Oct; consecutive days double-counted.
Gross, net sales, tax, refunds and payment-method totals were wrong every day.
The existing phase 15 test only passed when run after 12:00 UTC.

**Evidence:** with a bill paid at 08:40 IST, `GET /api/reports/sales` returned
`window {startUtc: 2026-10-12T12:00Z, endUtc: 2026-10-13T23:59Z}` and
`bills.count: 0`.

**Fix:** one shared, DST-safe `zonedDayBounds()` in `src/lib/timezone.ts`
(built on the existing, correct `zoneOffsetMs`). Both callers use it. An invalid
`?tz=` now returns 422 instead of a 500.

## BUG-2 — Day-restricted promotions never applied

**Where:** promotion selection in `createBillFromSession` (`src/lib/billing.ts`).

**What:** the promotions API and UI store `daysOfWeek` as `["MON", …, "SUN"]`.
The bill engine compared that list with `Intl`'s `"Mon"`, `"Tue"`, …, so
`["MON"].includes("Mon")` was always false.

**Impact:** every promotion with any weekday restriction (weekday lunch, weekend
offers, the seeded Mon–Fri demo promotion) was silently ignored, so guests were
charged full price.

**Evidence:** a 10% promotion valid on all seven days gave `discountMinor: 0`,
`promotionId: null`. On the same hotel, a 5% promotion with no day list applied
(`discountMinor: 1000`).

**Fix:** the window check moved to `promotionWindowOpen()` and compares weekdays
case-insensitively. Happy-hour logic is unchanged.

## BUG-3 — Thank-you / review email ignored opt-out

**Where:** `runRestaurantBillPaid` (`src/lib/retention.ts`).

**What:** the post-dining email (a review request ending "Reply STOP to opt
out") was gated on `marketingConsent` only. An inbound STOP reply
(`webhooks/tracking`) sets `optOut = true` but leaves `marketingConsent`
untouched. Revoking only the email channel clears `emailOptIn`. Both kinds of
customer kept receiving the email after every paid bill. Every other marketing
send uses `marketingConsent && emailOptIn && !optOut`.

**Evidence:** for a customer with `optOut = true`, the job returned
`thankYou: {ok: true, provider: "MOCK_EMAIL"}`, i.e. the email was sent.

**Fix:** `billThankYouSkipReason()` applies the canonical
`channelConsentOk(customer, "EMAIL")` gate; the outcome reports `opted_out` /
`no_consent` / `no_email`.

## BUG-4 — Outbound webhooks: SSRF via redirects and internal hosts

**Where:** `src/lib/webhooks-out.ts`.

**What:**
1. `deliverWebhook` used `fetch` with the default `redirect: "follow"`, so the
   documented "3xx → dead-letter" branch could never run. An endpoint could
   answer `303 Location: http://169.254.169.254/...` (or any internal
   `http://` service) and the worker would fetch it.
2. `validateWebhookUrl` only required `https:` in production. Loopback,
   RFC 1918, link-local and other internal hosts were accepted, despite the
   comment saying loopback is for dev/test only.

Any tenant owner/admin (`WEBHOOK_MANAGE`) could make the platform send requests
into its own network. The response status was visible to the tenant.

**Evidence:** an endpoint answering 303 led to `GET /internal-admin` on the
redirect target, and the delivery was recorded as `DELIVERED 200`.

**Fix:** `redirect: "manual"` (3xx is dead-lettered as designed). In production,
endpoint URLs must be public `https:` hosts (`isBlockedWebhookHost`). Delivery
re-checks the URL and the hostname's resolved addresses, which also covers
endpoints saved before this fix. Dev/test still allow loopback for contract
tests.

## BUG-5 — Cancelled reservations blocked their slot forever

**Where:** `Reservation @@unique([tableId, date, startTime])`, `src/lib/reservations.ts`.

**What:** the overlap check ignores CANCELLED / NO_SHOW / COMPLETED rows, but
the unique index covered all rows. Re-booking the same table at the same date
and start time after a cancellation hit the index and returned
`409 That table is already reserved for this slot`.

**Fix:** an `activeFence` column, following the existing
`TableSession.openFence` pattern: 1 while PENDING/CONFIRMED/SEATED, NULL once
inactive. The unique index is now `(tableId, date, startTime, activeFence)`,
and NULLs never collide. The change covers both Prisma schemas plus migration
`0012_reservation_active_fence`. The migration is re-runnable, backfills
existing rows, and replaces the index with a strictly more permissive one
(no data is touched).

## BUG-6 — PO receipt dropped duplicate-ingredient lines

**Where:** `PATCH /api/inventory/purchase-orders` (`RECEIVE`).

**What:** the exactly-once fence is one PURCHASE ledger row per
(ingredient, PO). A PO listing the same ingredient twice (split delivery,
two prices) received the first line and the fence skipped the rest, even
though the PO total still included them.

**Evidence:** lines 5000 g + 2000 g of one ingredient gave a stock of 5000.

**Fix:** `aggregateReceiptLines()` merges lines per ingredient (qty summed,
weighted unit cost) before the single fenced movement. Existing open POs are
fixed too.

## BUG-7 — Test runner: skipped suites, unpassable suites, self-inflicted wedge

**Where:** `scripts/run-tests.ts` (the only test entry point CI runs).

1. `tests/audit-2026-regressions.test.ts` and `tests/security-hardening.test.ts`
   were not in the hand-maintained `TEST_FILES` list, so CI never ran them (the
   same failure the file already documents for the audit-fixes suite). Both are
   now registered, and the runner fails if any `tests/*.test.ts` is missing.
2. Test files ran via `spawnSync`, which blocked the runner's event loop, so the
   dev server's piped stdout/stderr was not drained during a suite. Once a
   chatty suite filled the ~200 KB socket buffer, the server's synchronous log
   write blocked its event loop and every request hung (observed: main thread in
   `write(2, …)` / `sock_alloc_send_pskb`, runner in `do_wait`). This is the
   documented "wedge" the watchdog restarted the server for; `super-admin-platform`
   triggered it on every run here. Suites now run via an awaited async `spawn`.
3. Suites that could never pass: `phase10-saas` and `audit-fixes` (BUG-8),
   `phase18-ai` (BUG-9) and `scripts/test-phase1.ts`. Since SEC-006 (CSRF on
   logout, PR #2) the phase1 script's raw logout `fetch` sent no CSRF token, so
   logout was rejected and "Logout clears session" failed. The script now sends
   the token the same way its `call()` helper does.

## BUG-8 — Super Admin backups API missing from the repository

**Where:** `.gitignore` line 24, `backups/`.

**What:** the rule was meant for the backup archive folder (`BACKUP_DIR`
defaults to `<cwd>/backups`). Unanchored, it matches any directory named
`backups`, including `src/app/api/super-admin/backups/`. The route the Super
Admin Backups page calls (`GET` status/history, `POST` trigger,
`POST ?verify=1`) was therefore never committed. `tests/audit-fixes.test.ts`
documents it as "F02 Missing release routes restored", but that restore never
reached git either.

**Impact:** every build from git (CI, Docker) answers 404, so operators cannot
see backup status, trigger a backup or verify one from the UI.
`phase10-saas` (2 tests), `audit-fixes` and the PostgreSQL integration script
fail on it.

**Fix:** the rule is anchored to `/backups/` (archives stay ignored). The route
is restored from the contract its four callers define (super-admin guard with
CSRF and DB-role check, `getBackupStatus`/history, queued `triggerBackup` with a
required reason, `verifyLatestBackup`). A regression test asserts the file
exists and is not ignored.

## BUG-9 — WhatsApp chatbot webhook `replies` always empty

**Where:** `POST /api/ai/whatsapp/webhook`.

**What:** when replies moved to the tenant provider pipeline, the handler kept
returning `{ received: true, replies }`, documented as a diagnostics mirror of
what was sent, but never pushed into the array. Real WhatsApp delivery is
unaffected (Meta ignores response bodies). The diagnostics contract is broken,
and all six chatbot end-to-end tests in `phase18-ai` fail, hiding any real
chatbot regression.

**Fix:** each reply produced by the engine is recorded in `replies`.

---

## BUG-10 — `@/lib/permissions` could not be the entry module of its own import cycle

**Where:** `src/lib/custom-roles.ts` (module-scope `ALLOWED_CUSTOM_PERMISSIONS`),
in the cycle `permissions.ts → api-helpers.ts → custom-roles.ts → permissions.ts`
(`permissions` imports `jsonError`, `api-helpers` imports `resolveUserPermissions`,
`custom-roles` imports the `PERMISSIONS` catalog).

**What:** `custom-roles.ts` built its custom-role allowlist at module scope:

```ts
const ALLOWED_CUSTOM_PERMISSIONS = new Set<Permission>(
  PERMISSIONS.filter((p) => !RESERVED_PERMISSIONS.has(p)),
);
```

When `permissions.ts` is the first of the three modules to be evaluated, its
`PERMISSIONS` binding is still in the temporal dead zone while `custom-roles.ts`
runs, so the whole graph throws:

```
ReferenceError: Cannot access 'PERMISSIONS' before initialization.
    at src/lib/custom-roles.ts:28:3
```

**Impact:** `tests/unit.test.ts` imports `@/lib/permissions` before anything that
pulls in `api-helpers`, so the suite could not load at all:
`bun test tests/unit.test.ts` → `0 pass, 1 fail`, and since that file is
registered in `scripts/run-tests.ts`, **`bun run test` and CI failed** with the
27 security assertions never executed. The same crash would 500 any route,
script or worker chunk whose import list reaches `@/lib/permissions` before
`@/lib/api-helpers`; today all 204 route modules happen to import `api-helpers`
first, which is why the app itself still boots.

**Evidence (reproduced on the unfixed tree, bun 1.3.14 — the CI version):**

| Command | Unfixed | Fixed |
|---|---|---|
| `bun test tests/unit.test.ts` | 0 pass, 1 fail (TDZ `ReferenceError`) | 27 pass, 0 fail |
| `bun -e "await import('@/lib/permissions')"` | `ReferenceError: Cannot access 'PERMISSIONS' before initialization` | `PERMISSIONS.length = 88` |
| `bun test tests/import-cycle-regression.test.ts` | 0 pass, 4 fail | 4 pass, 0 fail |

**Fix:** the catalog is read on first use instead of at module scope
(`allowedCustomRolePermissions()`), so no cyclic binding is dereferenced during
module initialization. The allowlist contents and the reserved-permission
refusals are unchanged (`SUPER_ADMIN_ACCESS`, `BILL_REFUND`, `TAX_MANAGE`, …
still cannot be granted).

**Regression tests:** `tests/import-cycle-regression.test.ts` (registered in
`scripts/run-tests.ts`) — loads the cycle with `permissions.ts` first in a child
process, asserts the allowlist still refuses reserved permissions, guards
against a module-scope read coming back, and sweeps every `src/lib` module in a
fresh process so any future TDZ cycle fails the build.

---

## Observed, not changed (lower confidence or design decisions)

- **Cash drawer close:** expected cash subtracts every MANUAL refund created
  while the drawer was open, including card/UPI refunds and refunds of bills
  paid into other drawers (`BillRefund` records no method or drawer). This
  produces false variances; it needs a product decision on refund tender.
- **Manual payment idempotency** (`recordManualPayment`): check-then-insert on
  a `meta` substring with no unique fence; concurrent retries with one key can
  both record. Keys containing `"` never match.
- **Purchase order numbers:** `count + 1` with a unique `(hotelId, poNumber)`,
  so concurrent creates return 500 instead of retrying.
- **Partial refund response:** `refundOrVoidBill` reports `status: "REFUNDED"`
  for partial refunds (the stored bill status is correct).
- **Test order dependency:** `phase10-saas` "plan campaign limit" creates
  campaigns with `segmentId: segment?.id ?? ""`; on a database where no earlier
  suite created a segment for hotel B it fails with a foreign-key error. It
  passes in the runner's order.

## Verification

- `bun run typecheck` ✔, `bun run lint` ✔.
- New DB-free suite `tests/bugfix-regressions-2026-10.test.ts`, plus end-to-end
  tests added to phase 15 / 16 / 17. Each failed on the old code (repro) and
  passes now.
- Migration 0012 was applied (with 0001–0011) to a real PostgreSQL engine
  (PGlite): it is re-runnable, the backfill is correct, and the cancelled slot
  can be re-booked while a duplicate active booking is rejected. Prisma's own
  `migrate diff` drift check needs the CI Postgres service and was not run here.

# Database and Migration Audit — StayLoop (2026-10-11)

Method: static inspection of `prisma/schema.prisma` (SQLite, dev), `prisma/schema.postgres.prisma` (PostgreSQL, prod),
the 11 migration folders, and the CI/Docker migration steps. **No migration was applied and no database was touched**
(PostgreSQL and the Prisma schema engine are unavailable in this sandbox).

## Summary
| Check | Result | Status |
|---|---|---|
| Model set parity (SQLite vs PostgreSQL) | 110 models in each; identical names (ordering of `ApiKey` differs only) | PASS (static) |
| Enum parity | 55 in each | PASS (static) |
| Migrations apply cleanly to a fresh PostgreSQL 16 | Not run | BLOCKED |
| `migrate diff` migrations-vs-schema drift (CI gate) | Not run | BLOCKED |
| Destructive statements in forward migrations | None (`DROP`/`TRUNCATE`/`DELETE` appear only in rollback comments, e.g. `0011`) | PASS (static) |
| Money stored as integer minor units | Bills, payments, and invoices use `*Minor Int` (e.g. `priceMinor`, `totalMinor`, `paidMinor`) | PASS (static) |
| Money stored as `Float` | 14+ monetary fields are `Float` (see DB-001) | Known risk |
| Per-tenant unique constraints | Bill numbers (`hotelId, billNumber`), order numbers, PO numbers, coupon codes (`hotelId_code`) | PASS (static) |
| Tenant column on tenant-owned models | 83 of 110 models carry `hotelId`; the other 27 are child rows, platform-global, or join rows | Reviewed by name; see DB-003 |
| Cascade behaviour | 139 `onDelete: Cascade`, 21 `SetNull`, 0 `Restrict` | Noted (DB-004) |
| Indexes | 210 `@@index` declarations (PostgreSQL schema) | Present; query plans NOT checked |

## Findings

### DB-001 — Monetary fields stored as `Float` (Medium, confidence High on the type, Medium on impact)
- **Where:** `prisma/schema.postgres.prisma`: `Payment.amount`, `Payment.discountAmount`, `Payment.refundedAmount`,
  `Subscription.amount`, `Plan.monthlyPrice/yearlyPrice/setupFee`, `Coupon.discountValue/minimumOrder/maximumDiscount/totalDiscount`,
  `CouponRedemption.orderAmount/discountAmount`, `Visit.amount`, `RestaurantVisit.orderAmount`, `RestaurantOrder.totalAmount`,
  `LoyaltyAccount.lifetimeSpend`, `TimelineEvent.amount`, `CampaignMessage.bookingAmount/attributedRevenue`.
- **Observed:** The restaurant bill path (`src/lib/billing.ts`) is integer-minor and rounds coupon discounts with
  `roundMinor` (line ~477), so the bill arithmetic is sound. Elsewhere, `src/lib/coupons.ts` `computeDiscount()` returns
  fractional values (`orderAmount * discountValue / 100`, not rounded), and `/api/coupons/validate` displays that value.
  `src/lib/saas/billing.ts` writes `Payment.amount` from an `amountMinor` value (line ~228) into a `Float` column.
  `RestaurantOrder.totalAmount` has no reference in `src/lib` or `src/app/api` (possible dead column).
- **Impact:** Integer minor units stored in `Float` are exact up to 2^53, so the SaaS payment write is not lossy in practice.
  The real risk is fractional displayed or reported amounts (for example a 33.3-paise discount) and mixed units across the
  codebase (rupees in some fields, paise in others). Confirm the units of each field before any money-based report is trusted.
- **Status:** Not changed. A migration to `Int` minor units is a data-changing schema change and needs a backfill plan
  (see below). Recommend: convert `computeDiscount` callers to `roundMinor` (no schema change), then plan the column migration.

### DB-002 — Mixed money units across modules (Medium, Informational until verified)
- Restaurant bills: paise (`*Minor`). Coupons: rupees (`computeDiscount(coupon, subtotalMinor / 100)`, line ~476). The
  conversion `/100` and back `* 100` is applied at call sites. Any call site that skips it is a 100× error. Not exhaustively checked.

### DB-003 — Models with no direct `hotelId` (Low, needs per-model review)
Notable names: `OrderItem`, `BillLine`, `PurchaseOrderLine`, `StockCountLine`, `JourneyStep`, `SegmentMember`,
`WebhookDelivery` (scoped through `endpoint.hotelId`; verified in `src/app/api/webhooks/[id]/replay/route.ts` line 26),
`CustomRoleAssignment` (scoped through `customRole.hotelId` in `src/lib/custom-roles.ts`), `ABAssignment`, `CurrencyRate`, `SecretRotation`.
Platform-global models (`Plan`, `GlobalFeatureFlag`, `PlatformSetting`, `BackupRecord`, `PlatformNotificationTemplate`, `FranchiseOrganization`)
are expected to be global. Child-table isolation depends on the parent check in each route. Only the two cases noted above were verified.

### DB-004 — 139 cascade deletes (Informational)
Deleting a Hotel cascades widely. That is expected for tenant removal, but it is irreversible without a backup. The soft-delete
and archive patterns in the routes (menu items, tables, promotions) avoid this for day-to-day operations. Recommend: confirm
the tenant-deletion path requires SUPER_ADMIN, a confirmation step, and a fresh backup. Not verified.

### DB-005 — Transaction and concurrency patterns (Informational, partially verified)
The code uses conditional updates (`updateMany` with `status` in `where`), unique fences (`gatewayPaymentId`, `eventId`),
`withHotelWriteLock` for staff limits and last-admin checks, and an outbox (`BackgroundJob`) written in the same transaction as
a bill payment. These are good patterns. Concurrency behaviour was NOT executed (requires PostgreSQL).

## Migration procedure (as documented and as CI runs it)
1. `prisma migrate deploy --schema prisma/schema.postgres.prisma` (CI `postgres-migrations`; Dockerfile `migrate` target).
2. `prisma migrate diff --from-migrations … --to-schema-datamodel … --shadow-database-url …`, fails CI on any `CREATE|ALTER|DROP` drift.
3. `db:push` and `db:push:force` are **dev-only** (`docs/DATABASE.md`). `db:reset` is destructive. Not run.

## Safe migration plan for DB-001 (for a future change; not executed)
1. Add new `Int` columns (for example `amountMinor`) alongside the `Float` columns. Nullable at first.
2. Backfill with `ROUND(amount * 100)` in a single transaction, with a row count check before and after, on a restored copy of production.
3. Dual-write from application code. Verify totals match in reports for at least one billing cycle.
4. Switch readers, then drop the old columns in a later migration after a verified backup.
5. Rollback: keep the old columns until step 4 is verified; the backfill is idempotent.

## Not executed (blocked)
- Migration apply on PostgreSQL 16 · drift check · concurrent invoice/order creation tests · index and query-plan review · restore rehearsal.

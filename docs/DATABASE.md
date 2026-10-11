# StayLoop Database Guide

Engines: **PostgreSQL 16** in production, **SQLite** for dev/test only.
Schemas: `prisma/schema.prisma` (SQLite) and `prisma/schema.postgres.prisma`
(PostgreSQL) — kept model-for-model identical (36 models).

## 1. Migration strategy

- Production uses Prisma Migrate: `prisma/migrations/0001_init/migration.sql`
  (initial schema, 1300+ lines) + `migration_lock.toml` (postgresql).
- Apply: `bun run db:migrate:deploy` (or the compose `migrate` service).
- Dev/test use `prisma db push` against throwaway SQLite files (the test
  harness creates a fresh temp DB per run — no cleanup burden, full isolation).
- Safety rules: backup before migrating, test on a staging copy, never
  `migrate reset`/`db push --accept-data-loss` in production. See
  `docs/DEPLOYMENT.md` §4 and `docs/DISASTER_RECOVERY.md`.

## 2. Multi-tenancy model

- Tenant root: `Hotel` (id referenced as `hotelId` across 31 tenant-owned
  models). `User.hotelId` is nullable only for `SUPER_ADMIN`.
- Every tenant query derives `hotelId` from the authenticated session (DB
  re-read per request) — never from client input. Foreign-key cascades
  (`onDelete: Cascade`) remove owned rows with the tenant.

## 3. Concurrency & integrity guarantees (verified by tests)

| Concern | Mechanism |
|---|---|
| Double campaign send | `CampaignMessage @@unique([campaignId, customerId, channel])` + deterministic `idempotencyKey` — reserve-then-send, P2002 losers skip |
| Loyalty overdraft | `points: {increment/decrement}` inside transactions; sufficiency checked on post-decrement value; immutable ledger (`LoyaltyTransaction.idempotencyKey @unique`); `reconcileAccount` repairs drift |
| Coupon double redemption | atomic `totalRedemptions` increment w/ post-check rollback; per-customer slot reservation `@@unique([couponId, customerId, redemptionSlot])`; `@@unique([couponId, customerId, orderId])` |
| Duplicate customer | `Customer @@unique([hotelId, phone])` |
| Login throttling races | DB rows (`AuthAttempt`, `User.failedLoginAttempts/lockedUntil`) — safe across instances |
| Job double-claim | `BackgroundJob` status-checked optimistic `updateMany` (single winner), stale-lock recovery after 10 min |
| Cross-tenant credential reuse | AES-GCM AAD binds ciphertexts to the tenant (transplant fails auth) |

SQLite dev note: single-writer model + `connection_limit=1` + long socket
timeouts (`src/lib/db.ts`) keep concurrent tests deterministic; correctness
on PostgreSQL rests on the same unique constraints and transactions.

## 4. Indexes (frequently queried paths)

- Tenant scoping: `hotelId` indexed on all tenant-owned tables.
- Timelines/analytics: `Visit(checkin)`, `Visit(checkout)`, `Visit(customerId)`,
  `AuditLog(createdAt)`, `CampaignMessage(status)`, `CampaignMessage(sentAt)`.
- Auth: `User.email @unique`, `AuthAttempt(email, createdAt)`,
  `User(role)`.
- Queue: `BackgroundJob(status, runAt)` composite — the worker claim query —
  plus `hotelId`, `type`, `createdAt`.
- Lookup: `Customer(email)`, `Customer(vip/leadTier/birthday)`,
  `QRCode.code @unique`.
- Deliberate: no blind extra indexes — each listed index matches a measured
  query path.

## 5. Connection sizing

- Pool: explicit for SQLite (`connection_limit=1`), PostgreSQL defaults are
  adequate for the web tier; size `max_connections` ≥ web + worker instances.
- Production rejects `file:` URLs at startup (build phase exempted via
  `NEXT_PHASE`; runtime fail-fast preserved).

## 6. Soft delete & retention

- Customers deactivate (`status INACTIVE`) instead of hard delete for
  referential integrity; GDPR-style anonymization/delete is available via the
  customer delete endpoint (cascades owned rows).
- Export files: filesystem TTL 24 h (worker cleanup) — DB job rows retain only
  metadata.
- Security tokens (`ActivationToken`) are one-time consumed and purged when
  expired (worker housekeeping).
- `AuditLog` is append-only; apply your regulatory retention (e.g. 1–7 years)
  via a scheduled archiving job — not automatic by design.

## 7. Operational commands

| Command | Use |
|---|---|
| `bun run db:migrate:deploy` | apply migrations (production) |
| `bun run db:push` | dev SQLite sync |
| `bun run seed` | seed dev demo data (2 hotels, RBAC users, loyalty, QR, templates) |
| `bun run bootstrap:admin` | one-time first super admin (needs `ADMIN_BOOTSTRAP_SECRET`) |
| `bun run scripts/verify-phase7.ts` | queue round-trip self-check |
| `sqlite3 db/custom.db …` / `psql $DATABASE_URL` | ad-hoc inspection |

## 8. Backup & restore

See `docs/BACKUP_AND_RESTORE.md` (nightly `pg_dump` + WAL archiving,
encrypted offsite copies, restore runbook) and `docs/DISASTER_RECOVERY.md`
(RTO/RPO, point-in-time recovery, failover drill).

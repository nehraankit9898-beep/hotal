-- Migration 0006 — Phase 11/12/13 bug-fix release (idempotent, additive only).
--
-- BUG-1/D01: OrderEventType is missing ORDER_PREPARING — every first KDS
--   "Start" (item PENDING→PREPARING) derives an ORDER_PREPARING event write
--   that Prisma rejects (PrismaClientValidationError) AFTER the status has
--   already committed → 500 + lost audit event. Also adds ITEM_CANCELLED so
--   per-item cancellations are recorded distinctly from whole-order cancels.
--   New enum values are APPENDED (PostgreSQL can only ADD VALUE at the end)
--   and both statements are idempotent.
-- BUG-8/D05: TableSession lacked an OPEN-per-table uniqueness guarantee —
--   six concurrent QR scans produced six OPEN sessions for one table. The
--   (tableId, openFence) unique index enforces it at the DATABASE level
--   (openFence = 1 while OPEN, NULL once closed; NULLs are distinct).
-- BUG-7/D17: Plan lacked a dedicated menu-catalog entitlement — the menu item
--   cap wrongly reused restaurantsLimit (number of locations).
--
-- Safe to re-run: every statement checks before it mutates.

-- ------------------------------------------------------------------
-- 1. OrderEventType — additive enum members (BUG-1/D01)
-- ------------------------------------------------------------------
ALTER TYPE "OrderEventType" ADD VALUE IF NOT EXISTS 'ORDER_PREPARING';
ALTER TYPE "OrderEventType" ADD VALUE IF NOT EXISTS 'ITEM_CANCELLED';

-- ------------------------------------------------------------------
-- 2. TableSession — one OPEN session per table (BUG-8/D05)
-- ------------------------------------------------------------------
ALTER TABLE "TableSession" ADD COLUMN IF NOT EXISTS "openFence" INTEGER;

-- Stamp existing OPEN sessions as fenced (defensive: normally at most one
-- OPEN session per table should already exist; if an installation accumulated
-- duplicates from the old race, keep the OLDEST and close the rest first so
-- the unique index can be created).
DO $$
BEGIN
  -- Close duplicate OPEN sessions (all but the oldest per table).
  UPDATE "TableSession" SET "status" = 'CLOSED', "closedAt" = COALESCE("closedAt", NOW())
  WHERE "status" = 'OPEN'
    AND "id" NOT IN (
      SELECT MIN("id") FROM "TableSession" WHERE "status" = 'OPEN' GROUP BY "tableId"
    );
END $$;

UPDATE "TableSession" SET "openFence" = 1 WHERE "status" = 'OPEN' AND "openFence" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "TableSession_tableId_openFence_key"
  ON "TableSession"("tableId", "openFence");

-- ------------------------------------------------------------------
-- 3. Plan.menuItemsLimit — dedicated menu entitlement (BUG-7/D17)
-- ------------------------------------------------------------------
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "menuItemsLimit" INTEGER NOT NULL DEFAULT 0;

-- ------------------------------------------------------------------
-- 4. JourneyStepDelivery.retryCount — durable retry budget (BUG-5/D12)
-- ------------------------------------------------------------------
ALTER TABLE "JourneyStepDelivery" ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0;

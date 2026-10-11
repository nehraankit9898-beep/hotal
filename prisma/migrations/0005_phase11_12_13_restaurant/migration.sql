-- Phase 11/12/13 migration (PostgreSQL — production source of truth).
--
-- Safe upgrade path for EXISTING installations:
--   * All statements are additive (new enums, new tables, new columns, new
--     indexes) except the UserRole enum extension which appends values at the
--     END (safe for existing rows: old values keep their ordinal positions).
--   * No column is dropped or retyped; existing data is preserved.
--   * Existing QR codes keep working: QRCode.tableId is nullable and defaults
--     to NULL (unbound legacy codes behave exactly as before).
--   * HotelSettings gains two nullable/default columns — existing rows keep
--     their current behavior (no opening-hours gating until configured).
--
-- Rollback: see PHASE_11_HANDOFF.md §Rollback. In short, the new tables can
-- be dropped and the enum values left in place (PostgreSQL cannot remove
-- enum values portably); leftover enum values are inert without the tables.

-- =====================================================================
-- 1. Phase 11 — Developer API (ApiKey was missing from the production
--    schema: the dev SQLite schema had it, so the PostgreSQL client
--    typecheck/build failed. This synchronizes the model.)
-- =====================================================================

DO $$ BEGIN
  CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ApiKey" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT '["read"]',
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "requests" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ApiKey_hotelId_idx" ON "ApiKey"("hotelId");
CREATE INDEX IF NOT EXISTS "ApiKey_status_idx" ON "ApiKey"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

DO $$
BEGIN
   IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'ApiKey_hotelId_fkey'
   ) THEN
      ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
END $$;

-- =====================================================================
-- 2. Phase 13 — restaurant staff roles (appended at the END of the enum:
--    existing values keep their positions, existing rows are untouched).
-- =====================================================================

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'CASHIER';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'KITCHEN_STAFF';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'WAITER';

-- =====================================================================
-- 3. Phase 11 — durable journey execution (enrollment + step deliveries).
-- =====================================================================

DO $$ BEGIN
  CREATE TYPE "JourneyEnrollmentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "JourneyDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "JourneyEnrollment" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "JourneyEnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextStepIndex" INTEGER NOT NULL DEFAULT 0,
    "nextStepAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JourneyEnrollment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "JourneyEnrollment_hotelId_idx" ON "JourneyEnrollment"("hotelId");
CREATE INDEX IF NOT EXISTS "JourneyEnrollment_status_nextStepAt_idx" ON "JourneyEnrollment"("status", "nextStepAt");
CREATE UNIQUE INDEX IF NOT EXISTS "JourneyEnrollment_journeyId_customerId_key" ON "JourneyEnrollment"("journeyId", "customerId");

DO $$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'JourneyEnrollment_hotelId_fkey') THEN
      ALTER TABLE "JourneyEnrollment" ADD CONSTRAINT "JourneyEnrollment_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'JourneyEnrollment_journeyId_fkey') THEN
      ALTER TABLE "JourneyEnrollment" ADD CONSTRAINT "JourneyEnrollment_journeyId_fkey"
        FOREIGN KEY ("journeyId") REFERENCES "Journey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'JourneyEnrollment_customerId_fkey') THEN
      ALTER TABLE "JourneyEnrollment" ADD CONSTRAINT "JourneyEnrollment_customerId_fkey"
        FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
END $$;

CREATE TABLE IF NOT EXISTS "JourneyStepDelivery" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "journeyStepId" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "occurrenceKey" TEXT NOT NULL,
    "status" "JourneyDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "messageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JourneyStepDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "JourneyStepDelivery_hotelId_idx" ON "JourneyStepDelivery"("hotelId");
CREATE INDEX IF NOT EXISTS "JourneyStepDelivery_status_scheduledFor_idx" ON "JourneyStepDelivery"("status", "scheduledFor");
CREATE UNIQUE INDEX IF NOT EXISTS "JourneyStepDelivery_enrollmentId_journeyStepId_occurrenceKey_key"
  ON "JourneyStepDelivery"("enrollmentId", "journeyStepId", "occurrenceKey");

DO $$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'JourneyStepDelivery_enrollmentId_fkey') THEN
      ALTER TABLE "JourneyStepDelivery" ADD CONSTRAINT "JourneyStepDelivery_enrollmentId_fkey"
        FOREIGN KEY ("enrollmentId") REFERENCES "JourneyEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'JourneyStepDelivery_journeyStepId_fkey') THEN
      ALTER TABLE "JourneyStepDelivery" ADD CONSTRAINT "JourneyStepDelivery_journeyStepId_fkey"
        FOREIGN KEY ("journeyStepId") REFERENCES "JourneyStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'JourneyStepDelivery_hotelId_fkey') THEN
      ALTER TABLE "JourneyStepDelivery" ADD CONSTRAINT "JourneyStepDelivery_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
END $$;

-- =====================================================================
-- 4. Phase 12 — digital menu & table management.
-- =====================================================================

CREATE TABLE IF NOT EXISTS "MenuCategory" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuCategory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MenuCategory_hotelId_idx" ON "MenuCategory"("hotelId");
CREATE INDEX IF NOT EXISTS "MenuCategory_active_sortOrder_idx" ON "MenuCategory"("active", "sortOrder");

DO $$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MenuCategory_hotelId_fkey') THEN
      ALTER TABLE "MenuCategory" ADD CONSTRAINT "MenuCategory_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
END $$;

CREATE TABLE IF NOT EXISTS "MenuItem" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "dietaryTags" TEXT,
    "imageUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "prepMinutes" INTEGER NOT NULL DEFAULT 10,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MenuItem_hotelId_idx" ON "MenuItem"("hotelId");
CREATE INDEX IF NOT EXISTS "MenuItem_categoryId_idx" ON "MenuItem"("categoryId");
CREATE INDEX IF NOT EXISTS "MenuItem_active_available_idx" ON "MenuItem"("active", "available");

DO $$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MenuItem_hotelId_fkey') THEN
      ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MenuItem_categoryId_fkey') THEN
      ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_categoryId_fkey"
        FOREIGN KEY ("categoryId") REFERENCES "MenuCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
END $$;

CREATE TABLE IF NOT EXISTS "MenuOptionGroup" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuOptionGroup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MenuOptionGroup_hotelId_idx" ON "MenuOptionGroup"("hotelId");
CREATE INDEX IF NOT EXISTS "MenuOptionGroup_menuItemId_idx" ON "MenuOptionGroup"("menuItemId");

DO $$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MenuOptionGroup_hotelId_fkey') THEN
      ALTER TABLE "MenuOptionGroup" ADD CONSTRAINT "MenuOptionGroup_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MenuOptionGroup_menuItemId_fkey') THEN
      ALTER TABLE "MenuOptionGroup" ADD CONSTRAINT "MenuOptionGroup_menuItemId_fkey"
        FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
END $$;

CREATE TABLE IF NOT EXISTS "MenuOption" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "optionGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceDeltaMinor" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuOption_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MenuOption_hotelId_idx" ON "MenuOption"("hotelId");
CREATE INDEX IF NOT EXISTS "MenuOption_optionGroupId_idx" ON "MenuOption"("optionGroupId");

DO $$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MenuOption_hotelId_fkey') THEN
      ALTER TABLE "MenuOption" ADD CONSTRAINT "MenuOption_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MenuOption_optionGroupId_fkey') THEN
      ALTER TABLE "MenuOption" ADD CONSTRAINT "MenuOption_optionGroupId_fkey"
        FOREIGN KEY ("optionGroupId") REFERENCES "MenuOptionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
END $$;

CREATE TABLE IF NOT EXISTS "DiningTable" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 4,
    "zone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiningTable_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DiningTable_hotelId_idx" ON "DiningTable"("hotelId");
CREATE INDEX IF NOT EXISTS "DiningTable_active_idx" ON "DiningTable"("active");
CREATE UNIQUE INDEX IF NOT EXISTS "DiningTable_hotelId_number_key" ON "DiningTable"("hotelId", "number");

DO $$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DiningTable_hotelId_fkey') THEN
      ALTER TABLE "DiningTable" ADD CONSTRAINT "DiningTable_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
END $$;

-- QR ↔ table binding (nullable — legacy codes stay unbound).
ALTER TABLE "QRCode" ADD COLUMN IF NOT EXISTS "tableId" TEXT;
CREATE INDEX IF NOT EXISTS "QRCode_tableId_idx" ON "QRCode"("tableId");
DO $$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'QRCode_tableId_fkey') THEN
      ALTER TABLE "QRCode" ADD CONSTRAINT "QRCode_tableId_fkey"
        FOREIGN KEY ("tableId") REFERENCES "DiningTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   END IF;
END $$;

-- Restaurant profile foundation: opening hours (display-only until gated).
ALTER TABLE "HotelSettings" ADD COLUMN IF NOT EXISTS "openingHours" TEXT;
ALTER TABLE "HotelSettings" ADD COLUMN IF NOT EXISTS "openingHoursGating" BOOLEAN NOT NULL DEFAULT false;

-- =====================================================================
-- 5. Phase 13 — ordering, table sessions, KDS, order events.
-- =====================================================================

DO $$ BEGIN
  CREATE TYPE "TableSessionStatus" AS ENUM ('OPEN', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "TableSession" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "status" "TableSessionStatus" NOT NULL DEFAULT 'OPEN',
    "guestName" TEXT,
    "guestPhone" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "publicToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TableSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TableSession_hotelId_idx" ON "TableSession"("hotelId");
CREATE INDEX IF NOT EXISTS "TableSession_tableId_idx" ON "TableSession"("tableId");
CREATE INDEX IF NOT EXISTS "TableSession_status_idx" ON "TableSession"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "TableSession_publicToken_key" ON "TableSession"("publicToken");

DO $$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TableSession_hotelId_fkey') THEN
      ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TableSession_tableId_fkey') THEN
      ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_tableId_fkey"
        FOREIGN KEY ("tableId") REFERENCES "DiningTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
END $$;

DO $$ BEGIN
  CREATE TYPE "DiningOrderStatus" AS ENUM ('PLACED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DiningOrderSource" AS ENUM ('QR_CUSTOMER', 'STAFF');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "OrderItemStatus" AS ENUM ('PENDING', 'PREPARING', 'READY', 'SERVED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "DiningOrder" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "tableSessionId" TEXT,
    "tableId" TEXT,
    "orderNumber" INTEGER NOT NULL,
    "status" "DiningOrderStatus" NOT NULL DEFAULT 'PLACED',
    "source" "DiningOrderSource" NOT NULL DEFAULT 'QR_CUSTOMER',
    "subtotalMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "notes" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "publicToken" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "placedByUserId" TEXT,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "servedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiningOrder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DiningOrder_hotelId_idx" ON "DiningOrder"("hotelId");
CREATE INDEX IF NOT EXISTS "DiningOrder_tableSessionId_idx" ON "DiningOrder"("tableSessionId");
CREATE INDEX IF NOT EXISTS "DiningOrder_status_idx" ON "DiningOrder"("status");
CREATE INDEX IF NOT EXISTS "DiningOrder_placedAt_idx" ON "DiningOrder"("placedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "DiningOrder_hotelId_orderNumber_key" ON "DiningOrder"("hotelId", "orderNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "DiningOrder_publicToken_key" ON "DiningOrder"("publicToken");
CREATE UNIQUE INDEX IF NOT EXISTS "DiningOrder_idempotencyKey_key" ON "DiningOrder"("idempotencyKey");

DO $$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DiningOrder_hotelId_fkey') THEN
      ALTER TABLE "DiningOrder" ADD CONSTRAINT "DiningOrder_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DiningOrder_tableSessionId_fkey') THEN
      ALTER TABLE "DiningOrder" ADD CONSTRAINT "DiningOrder_tableSessionId_fkey"
        FOREIGN KEY ("tableSessionId") REFERENCES "TableSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   END IF;
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DiningOrder_tableId_fkey') THEN
      ALTER TABLE "DiningOrder" ADD CONSTRAINT "DiningOrder_tableId_fkey"
        FOREIGN KEY ("tableId") REFERENCES "DiningTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   END IF;
END $$;

CREATE TABLE IF NOT EXISTS "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "menuItemId" TEXT,
    "nameSnapshot" TEXT NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "optionsSnapshot" TEXT,
    "lineTotalMinor" INTEGER NOT NULL,
    "notes" TEXT,
    "status" "OrderItemStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OrderItem_orderId_idx" ON "OrderItem"("orderId");
CREATE INDEX IF NOT EXISTS "OrderItem_menuItemId_idx" ON "OrderItem"("menuItemId");

DO $$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderItem_orderId_fkey') THEN
      ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey"
        FOREIGN KEY ("orderId") REFERENCES "DiningOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderItem_menuItemId_fkey') THEN
      ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_menuItemId_fkey"
        FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   END IF;
END $$;

DO $$ BEGIN
  CREATE TYPE "OrderEventType" AS ENUM (
    'ORDER_PLACED', 'ORDER_CONFIRMED', 'ITEM_PREPARING', 'ITEM_READY',
    'ORDER_READY', 'ITEM_SERVED', 'ORDER_SERVED', 'ORDER_CANCELLED', 'NOTE_ADDED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "OrderEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "type" "OrderEventType" NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OrderEvent_orderId_idx" ON "OrderEvent"("orderId");
CREATE INDEX IF NOT EXISTS "OrderEvent_hotelId_idx" ON "OrderEvent"("hotelId");
CREATE INDEX IF NOT EXISTS "OrderEvent_createdAt_idx" ON "OrderEvent"("createdAt");

DO $$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderEvent_orderId_fkey') THEN
      ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey"
        FOREIGN KEY ("orderId") REFERENCES "DiningOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderEvent_hotelId_fkey') THEN
      ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
END $$;

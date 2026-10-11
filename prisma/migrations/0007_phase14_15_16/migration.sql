-- Migration 0007 — Phase 14/15/16 (PostgreSQL — production source of truth).
-- POS/GST billing, retention & marketing, operations/inventory/multi-branch.
--
-- Safe upgrade path for EXISTING installations:
--   * Every statement is ADDITIVE (new enums, new tables, new columns, new
--     indexes). No column is dropped or retyped; existing data is preserved.
--   * BackgroundJobType gains two APPENDED values (PostgreSQL can only ADD
--     VALUE at the end); no existing value is modified or removed.
--   * HotelSettings gains nullable/defaulted columns — existing rows keep
--     their behavior (alerts off, reservation cap 20, no lead time).
--   * Unique fences (ledger exactly-once, reservation slot, invoice series,
--     idempotency keys) are created with existence guards — safe on
--     partially migrated installations.
--
-- Rollback: drop the new tables and the added HotelSettings columns (see
-- PHASE_16_HANDOFF.md §Rollback). Appended enum values are inert without
-- their tables and cannot be portably removed from PostgreSQL.
--
-- Safe to re-run: every statement checks before it mutates.

-- ------------------------------------------------------------------
-- 1. Enum type additions (all NEW types; existing types only gain values)
-- ------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "TaxRuleType" AS ENUM ('CGST_SGST', 'IGST', 'EXEMPT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BillStatus" AS ENUM ('ISSUED', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'PAID', 'VOID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BillPaymentMethod" AS ENUM ('CASH', 'UPI', 'CARD', 'ONLINE', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BillPaymentStatus" AS ENUM ('RECORDED', 'CAPTURED', 'FAILED', 'REFUNDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BillPaymentSource" AS ENUM ('MANUAL', 'GATEWAY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BillRefundType" AS ENUM ('REFUND', 'VOID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "RefundMode" AS ENUM ('MANUAL', 'GATEWAY', 'PENDING');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CashSessionStatus" AS ENUM ('OPEN', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentLinkStatus" AS ENUM ('ACTIVE', 'PAID', 'EXPIRED', 'REVOKED', 'VOID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'QUALIFIED', 'REWARDED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ReservationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'SEATED', 'CANCELLED', 'NO_SHOW', 'COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ReservationSource" AS ENUM ('STAFF', 'PUBLIC');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StockReason" AS ENUM ('OPENING', 'PURCHASE', 'CONSUMPTION', 'WASTAGE', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'RECEIVED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StockCountStatus" AS ENUM ('OPEN', 'COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'LEAVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Append at END of existing enum (Phase 14/15 job types)
ALTER TYPE "BackgroundJobType" ADD VALUE IF NOT EXISTS 'RESTAURANT_BILL_PAID';
ALTER TYPE "BackgroundJobType" ADD VALUE IF NOT EXISTS 'OWNER_REPORT';

-- ------------------------------------------------------------------
-- 2. HotelSettings — billing/reputation/reservation settings columns
-- ------------------------------------------------------------------
ALTER TABLE "HotelSettings" ADD COLUMN IF NOT EXISTS "reviewUrl" TEXT;
ALTER TABLE "HotelSettings" ADD COLUMN IF NOT EXISTS "feedbackAlertThreshold" INTEGER;
ALTER TABLE "HotelSettings" ADD COLUMN IF NOT EXISTS "reservationMaxPartySize" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "HotelSettings" ADD COLUMN IF NOT EXISTS "reservationLeadMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "HotelSettings" ADD COLUMN IF NOT EXISTS "socialConfigJson" TEXT;

-- ------------------------------------------------------------------
-- 3. Phase 14 — POS, GST billing & payments
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "TaxRule" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "TaxRuleType" NOT NULL DEFAULT 'CGST_SGST',
    "rateBps" INTEGER NOT NULL,
    "isInclusive" BOOLEAN NOT NULL DEFAULT true,
    "scopeType" TEXT NOT NULL DEFAULT 'ALL',
    "scopeIds" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TaxRule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TaxRule_hotelId_active_idx" ON "TaxRule"("hotelId", "active");
CREATE INDEX IF NOT EXISTS "TaxRule_hotelId_effectiveFrom_idx" ON "TaxRule"("hotelId", "effectiveFrom");
DO $$ BEGIN
  ALTER TABLE "TaxRule" ADD CONSTRAINT "TaxRule_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "InvoiceSequence" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT 'INV',
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "InvoiceSequence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "InvoiceSequence_hotelId_series_key" ON "InvoiceSequence"("hotelId", "series");
DO $$ BEGIN
  ALTER TABLE "InvoiceSequence" ADD CONSTRAINT "InvoiceSequence_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Bill" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "billNumber" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "seqNumber" INTEGER NOT NULL,
    "status" "BillStatus" NOT NULL DEFAULT 'ISSUED',
    "tableSessionId" TEXT,
    "tableId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "subtotalMinor" INTEGER NOT NULL DEFAULT 0,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "serviceChargeMinor" INTEGER NOT NULL DEFAULT 0,
    "taxMinor" INTEGER NOT NULL DEFAULT 0,
    "roundOffMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL DEFAULT 0,
    "paidMinor" INTEGER NOT NULL DEFAULT 0,
    "refundMinor" INTEGER NOT NULL DEFAULT 0,
    "couponCode" TEXT,
    "couponRedemptionId" TEXT,
    "promotionId" TEXT,
    "promotionVersion" INTEGER,
    "promotionLabel" TEXT,
    "discountReason" TEXT,
    "discountByUserId" TEXT,
    "customerId" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "taxSnapshot" TEXT,
    "legalSnapshot" TEXT,
    "notes" TEXT,
    "issuedByUserId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Bill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Bill_hotelId_billNumber_key" ON "Bill"("hotelId", "billNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "Bill_idempotencyKey_key" ON "Bill"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "Bill_hotelId_status_idx" ON "Bill"("hotelId", "status");
CREATE INDEX IF NOT EXISTS "Bill_hotelId_issuedAt_idx" ON "Bill"("hotelId", "issuedAt");
CREATE INDEX IF NOT EXISTS "Bill_tableSessionId_idx" ON "Bill"("tableSessionId");
CREATE INDEX IF NOT EXISTS "Bill_customerId_idx" ON "Bill"("customerId");
DO $$ BEGIN
  ALTER TABLE "Bill" ADD CONSTRAINT "Bill_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Bill" ADD CONSTRAINT "Bill_tableSessionId_fkey"
    FOREIGN KEY ("tableSessionId") REFERENCES "TableSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Bill" ADD CONSTRAINT "Bill_tableId_fkey"
    FOREIGN KEY ("tableId") REFERENCES "DiningTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Bill" ADD CONSTRAINT "Bill_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "BillLine" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "orderId" TEXT,
    "orderItemId" TEXT,
    "nameSnapshot" TEXT NOT NULL,
    "hsnCode" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "lineSubtotalMinor" INTEGER NOT NULL,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "taxableMinor" INTEGER NOT NULL DEFAULT 0,
    "taxMinor" INTEGER NOT NULL DEFAULT 0,
    "lineTotalMinor" INTEGER NOT NULL,
    "taxBreakup" TEXT,
    CONSTRAINT "BillLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BillLine_billId_idx" ON "BillLine"("billId");
DO $$ BEGIN
  ALTER TABLE "BillLine" ADD CONSTRAINT "BillLine_billId_fkey"
    FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "BillPayment" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "method" "BillPaymentMethod" NOT NULL,
    "source" "BillPaymentSource" NOT NULL DEFAULT 'MANUAL',
    "status" "BillPaymentStatus" NOT NULL DEFAULT 'RECORDED',
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "gateway" TEXT,
    "gatewayOrderId" TEXT,
    "gatewayPaymentId" TEXT,
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "cashSessionId" TEXT,
    "reference" TEXT,
    "recordedByUserId" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" TEXT,
    CONSTRAINT "BillPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BillPayment_gatewayPaymentId_key" ON "BillPayment"("gatewayPaymentId");
CREATE INDEX IF NOT EXISTS "BillPayment_billId_idx" ON "BillPayment"("billId");
CREATE INDEX IF NOT EXISTS "BillPayment_hotelId_paidAt_idx" ON "BillPayment"("hotelId", "paidAt");
CREATE INDEX IF NOT EXISTS "BillPayment_cashSessionId_idx" ON "BillPayment"("cashSessionId");
DO $$ BEGIN
  ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_billId_fkey"
    FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "BillRefund" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "type" "BillRefundType" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "reason" TEXT NOT NULL,
    "mode" "RefundMode" NOT NULL DEFAULT 'MANUAL',
    "gateway" TEXT,
    "gatewayRefundId" TEXT,
    "approvedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillRefund_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BillRefund_billId_idx" ON "BillRefund"("billId");
CREATE INDEX IF NOT EXISTS "BillRefund_hotelId_idx" ON "BillRefund"("hotelId");
DO $$ BEGIN
  ALTER TABLE "BillRefund" ADD CONSTRAINT "BillRefund_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BillRefund" ADD CONSTRAINT "BillRefund_billId_fkey"
    FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "CashSession" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "status" "CashSessionStatus" NOT NULL DEFAULT 'OPEN',
    "openFence" INTEGER,
    "openingFloatMinor" INTEGER NOT NULL DEFAULT 0,
    "cashSalesMinor" INTEGER,
    "refundMinor" INTEGER,
    "adjustmentsMinor" INTEGER,
    "expectedCashMinor" INTEGER,
    "countedCashMinor" INTEGER,
    "varianceMinor" INTEGER,
    "notes" TEXT,
    "openedByUserId" TEXT NOT NULL,
    "closedByUserId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    CONSTRAINT "CashSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CashSession_hotelId_openFence_key" ON "CashSession"("hotelId", "openFence");
CREATE INDEX IF NOT EXISTS "CashSession_hotelId_status_idx" ON "CashSession"("hotelId", "status");
CREATE INDEX IF NOT EXISTS "CashSession_hotelId_openedAt_idx" ON "CashSession"("hotelId", "openedAt");
DO $$ BEGIN
  ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------------
-- 4. Phase 15 — retention & marketing
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ReferralProgram" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "referrerRewardType" TEXT NOT NULL DEFAULT 'POINTS',
    "referrerRewardValue" INTEGER NOT NULL DEFAULT 100,
    "refereeRewardType" TEXT NOT NULL DEFAULT 'POINTS',
    "refereeRewardValue" INTEGER NOT NULL DEFAULT 100,
    "minSpendMinor" INTEGER,
    "maxRewardsPerReferrer" INTEGER,
    "terms" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReferralProgram_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReferralProgram_hotelId_key" ON "ReferralProgram"("hotelId");
DO $$ BEGIN
  ALTER TABLE "ReferralProgram" ADD CONSTRAINT "ReferralProgram_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ReferralCode" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReferralCode_hotelId_code_key" ON "ReferralCode"("hotelId", "code");
CREATE UNIQUE INDEX IF NOT EXISTS "ReferralCode_hotelId_customerId_key" ON "ReferralCode"("hotelId", "customerId");
CREATE INDEX IF NOT EXISTS "ReferralCode_hotelId_idx" ON "ReferralCode"("hotelId");
DO $$ BEGIN
  ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Referral" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "referrerCustomerId" TEXT NOT NULL,
    "refereeCustomerId" TEXT NOT NULL,
    "codeId" TEXT,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "qualifiedBillId" TEXT,
    "rewardedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Referral_hotelId_refereeCustomerId_key" ON "Referral"("hotelId", "refereeCustomerId");
CREATE INDEX IF NOT EXISTS "Referral_hotelId_status_idx" ON "Referral"("hotelId", "status");
DO $$ BEGIN
  ALTER TABLE "Referral" ADD CONSTRAINT "Referral_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerCustomerId_fkey"
    FOREIGN KEY ("referrerCustomerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Referral" ADD CONSTRAINT "Referral_refereeCustomerId_fkey"
    FOREIGN KEY ("refereeCustomerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Promotion" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "percentBps" INTEGER,
    "valueMinor" INTEGER,
    "itemIdsJson" TEXT,
    "categoryIdsJson" TEXT,
    "daysOfWeek" TEXT,
    "startTime" TEXT,
    "endTime" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Promotion_hotelId_active_idx" ON "Promotion"("hotelId", "active");
DO $$ BEGIN
  ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "PaymentLink" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentVia" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "gatewayOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentLink_token_key" ON "PaymentLink"("token");
CREATE INDEX IF NOT EXISTS "PaymentLink_billId_idx" ON "PaymentLink"("billId");
CREATE INDEX IF NOT EXISTS "PaymentLink_hotelId_status_idx" ON "PaymentLink"("hotelId", "status");
DO $$ BEGIN
  ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_billId_fkey"
    FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ReportSchedule" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'DAILY',
    "weekday" INTEGER,
    "hour" INTEGER NOT NULL DEFAULT 21,
    "recipients" TEXT NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSentAt" TIMESTAMP(3),
    "lastResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReportSchedule_hotelId_key" ON "ReportSchedule"("hotelId");
DO $$ BEGIN
  ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "RestaurantWebhookEvent" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROCESSED',
    "payload" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RestaurantWebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "RestaurantWebhookEvent_provider_eventId_key" ON "RestaurantWebhookEvent"("provider", "eventId");
CREATE INDEX IF NOT EXISTS "RestaurantWebhookEvent_hotelId_idx" ON "RestaurantWebhookEvent"("hotelId");
DO $$ BEGIN
  ALTER TABLE "RestaurantWebhookEvent" ADD CONSTRAINT "RestaurantWebhookEvent_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------------
-- 5. Phase 16 — operations, inventory & multi-branch
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Reservation" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "tableId" TEXT,
    "date" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 90,
    "partySize" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'PENDING',
    "guestName" TEXT NOT NULL,
    "guestPhone" TEXT NOT NULL,
    "notes" TEXT,
    "source" "ReservationSource" NOT NULL DEFAULT 'STAFF',
    "publicToken" TEXT,
    "createdByUserId" TEXT,
    "confirmedByUserId" TEXT,
    "seatedAt" TIMESTAMP(3),
    "tableSessionId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Reservation_tableId_date_startTime_key" ON "Reservation"("tableId", "date", "startTime");
CREATE INDEX IF NOT EXISTS "Reservation_hotelId_date_idx" ON "Reservation"("hotelId", "date");
CREATE INDEX IF NOT EXISTS "Reservation_hotelId_status_idx" ON "Reservation"("hotelId", "status");
DO $$ BEGIN
  ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_tableId_fkey"
    FOREIGN KEY ("tableId") REFERENCES "DiningTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Ingredient" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'PIECE',
    "costPerUnitMinor" INTEGER NOT NULL DEFAULT 0,
    "stockQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lowStockThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Ingredient_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Ingredient_hotelId_idx" ON "Ingredient"("hotelId");
CREATE INDEX IF NOT EXISTS "Ingredient_hotelId_active_idx" ON "Ingredient"("hotelId", "active");
DO $$ BEGIN
  ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "StockLedger" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "reason" "StockReason" NOT NULL,
    "qtyDelta" DOUBLE PRECISION NOT NULL,
    "balanceAfter" DOUBLE PRECISION NOT NULL,
    "unitCostMinor" INTEGER,
    "refType" TEXT,
    "refId" TEXT,
    "wastageReason" TEXT,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockLedger_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StockLedger_ingredientId_refType_refId_reason_key" ON "StockLedger"("ingredientId", "refType", "refId", "reason");
CREATE INDEX IF NOT EXISTS "StockLedger_hotelId_createdAt_idx" ON "StockLedger"("hotelId", "createdAt");
CREATE INDEX IF NOT EXISTS "StockLedger_ingredientId_idx" ON "StockLedger"("ingredientId");
DO $$ BEGIN
  ALTER TABLE "StockLedger" ADD CONSTRAINT "StockLedger_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "StockLedger" ADD CONSTRAINT "StockLedger_ingredientId_fkey"
    FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "RecipeLine" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "qtyPerUnit" DOUBLE PRECISION NOT NULL,
    "variantKey" TEXT,
    CONSTRAINT "RecipeLine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "RecipeLine_menuItemId_ingredientId_variantKey_key" ON "RecipeLine"("menuItemId", "ingredientId", "variantKey");
CREATE INDEX IF NOT EXISTS "RecipeLine_hotelId_idx" ON "RecipeLine"("hotelId");
DO $$ BEGIN
  ALTER TABLE "RecipeLine" ADD CONSTRAINT "RecipeLine_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "RecipeLine" ADD CONSTRAINT "RecipeLine_menuItemId_fkey"
    FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "RecipeLine" ADD CONSTRAINT "RecipeLine_ingredientId_fkey"
    FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Supplier" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Supplier_hotelId_idx" ON "Supplier"("hotelId");
DO $$ BEGIN
  ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "poNumber" INTEGER NOT NULL,
    "expectedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "notes" TEXT,
    "totalMinor" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseOrder_hotelId_poNumber_key" ON "PurchaseOrder"("hotelId", "poNumber");
CREATE INDEX IF NOT EXISTS "PurchaseOrder_hotelId_status_idx" ON "PurchaseOrder"("hotelId", "status");
DO $$ BEGIN
  ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "unitCostMinor" INTEGER NOT NULL,
    "lineTotalMinor" INTEGER NOT NULL,
    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PurchaseOrderLine_purchaseOrderId_idx" ON "PurchaseOrderLine"("purchaseOrderId");
DO $$ BEGIN
  ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey"
    FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_ingredientId_fkey"
    FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "StockCount" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'OPEN',
    "countedByUserId" TEXT,
    "completedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "StockCount_hotelId_status_idx" ON "StockCount"("hotelId", "status");
DO $$ BEGIN
  ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "StockCountLine" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "systemQty" DOUBLE PRECISION NOT NULL,
    "countedQty" DOUBLE PRECISION NOT NULL,
    "delta" DOUBLE PRECISION NOT NULL,
    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StockCountLine_countId_ingredientId_key" ON "StockCountLine"("countId", "ingredientId");
DO $$ BEGIN
  ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_countId_fkey"
    FOREIGN KEY ("countId") REFERENCES "StockCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_ingredientId_fkey"
    FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "AttendanceRecord" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'PRESENT',
    "clockInAt" TIMESTAMP(3),
    "clockOutAt" TIMESTAMP(3),
    "minutesWorked" INTEGER,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "correctionLog" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AttendanceRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AttendanceRecord_hotelId_userId_date_key" ON "AttendanceRecord"("hotelId", "userId", "date");
CREATE INDEX IF NOT EXISTS "AttendanceRecord_hotelId_date_idx" ON "AttendanceRecord"("hotelId", "date");
DO $$ BEGIN
  ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ShiftAssignment" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "role" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShiftAssignment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ShiftAssignment_hotelId_date_idx" ON "ShiftAssignment"("hotelId", "date");
CREATE INDEX IF NOT EXISTS "ShiftAssignment_userId_date_idx" ON "ShiftAssignment"("userId", "date");
DO $$ BEGIN
  ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "BranchGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BranchGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BranchMembership" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BranchMembership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BranchMembership_hotelId_key" ON "BranchMembership"("hotelId");
CREATE INDEX IF NOT EXISTS "BranchMembership_groupId_idx" ON "BranchMembership"("groupId");
DO $$ BEGIN
  ALTER TABLE "BranchMembership" ADD CONSTRAINT "BranchMembership_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "BranchGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BranchMembership" ADD CONSTRAINT "BranchMembership_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

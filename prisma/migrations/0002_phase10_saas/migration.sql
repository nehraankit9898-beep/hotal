-- StayLoop — Phase 10 (Super Admin SaaS) incremental migration for PostgreSQL.
-- Applies ON TOP OF 0001_init: plans/pricing, trial + subscription lifecycle,
-- billing payments, coupons, global feature flags, platform settings,
-- security events, backups, notification templates and MFA columns.
-- SQLite dev databases use `prisma db push` (schema.prisma) — this file is
-- the production PostgreSQL path (db:migrate:deploy).

-- ---------- New enums ----------
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'YEARLY');
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');
CREATE TYPE "BillingCouponType" AS ENUM ('PERCENT', 'FIXED');

-- Subscription lifecycle states (additive — existing values unchanged).
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'GRACE';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'PAUSED';

-- ---------- Plan: dynamic pricing / features / limits ----------
ALTER TABLE "Plan" ADD COLUMN "key" TEXT;
ALTER TABLE "Plan" ADD COLUMN "yearlyPrice" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE "Plan" ADD COLUMN "setupFee" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN "trialDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN "graceDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Plan" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Plan" ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Plan" ADD COLUMN "recommended" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Plan" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN "features" TEXT;
ALTER TABLE "Plan" ADD COLUMN "apiRequestLimit" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN "exportsLimit" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN "locationsLimit" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN "restaurantsLimit" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN "whatsappMessageLimit" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN "smsMessageLimit" INTEGER NOT NULL DEFAULT 0;

-- Backfill the stable key from the unique name (idempotent on re-run).
UPDATE "Plan" SET "key" = lower(regexp_replace("name", '[^a-zA-Z0-9]+', '-', 'g')) WHERE "key" IS NULL;
UPDATE "Plan" SET
  "yearlyPrice" = "monthlyPrice" * 10,
  "trialDays" = 14,
  "graceDays" = 7,
  "isPublic" = true,
  "isActive" = true,
  "features" = '["ROOM_CRM","CUSTOMER_CRM","CAMPAIGNS","ANALYTICS","OFFERS","WHATSAPP","SMS","EMAIL","REPORTS"]',
  "apiRequestLimit" = CASE WHEN "apiAccess" THEN 50000 ELSE 0 END,
  "exportsLimit" = 50
WHERE "yearlyPrice" = 0;
ALTER TABLE "Plan" ALTER COLUMN "key" SET NOT NULL;
CREATE UNIQUE INDEX "Plan_key_key" ON "Plan"("key");

-- ---------- Subscription: trial engine + provider linkage ----------
ALTER TABLE "Subscription" ADD COLUMN "billingCycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY';
ALTER TABLE "Subscription" ADD COLUMN "trialStartsAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "graceEndsAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "pausedAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "expiredAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "provider" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "providerRef" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "nextInvoiceAt" TIMESTAMP(3);
CREATE INDEX "Subscription_trialEndsAt_idx" ON "Subscription"("trialEndsAt");

-- ---------- Payment (invoices / checkout / webhooks) ----------
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "planId" TEXT,
    "invoiceNumber" TEXT NOT NULL,
    "description" TEXT,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "providerPaymentId" TEXT,
    "providerOrderId" TEXT,
    "idempotencyKey" TEXT,
    "couponId" TEXT,
    "couponCode" TEXT,
    "billingCycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "failureReason" TEXT,
    "refundedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "metadata" TEXT,
    "paidAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Payment_invoiceNumber_key" ON "Payment"("invoiceNumber");
CREATE UNIQUE INDEX "Payment_providerPaymentId_key" ON "Payment"("providerPaymentId");
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");
CREATE INDEX "Payment_hotelId_idx" ON "Payment"("hotelId");
CREATE INDEX "Payment_status_idx" ON "Payment"("status");
CREATE INDEX "Payment_subscriptionId_idx" ON "Payment"("subscriptionId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- BillingCoupon ----------
CREATE TABLE "BillingCoupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "discountType" "BillingCouponType" NOT NULL DEFAULT 'PERCENT',
    "percentOff" INTEGER,
    "amountOff" DOUBLE PRECISION,
    "maxDiscountAmount" DOUBLE PRECISION,
    "minAmount" DOUBLE PRECISION,
    "usageLimit" INTEGER,
    "perTenantLimit" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "usedByTenants" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "applicablePlans" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BillingCoupon_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BillingCoupon_code_key" ON "BillingCoupon"("code");
CREATE INDEX "BillingCoupon_isActive_idx" ON "BillingCoupon"("isActive");

-- ---------- GlobalFeatureFlag ----------
CREATE TABLE "GlobalFeatureFlag" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "force" BOOLEAN NOT NULL DEFAULT false,
    "activateAt" TIMESTAMP(3),
    "deactivateAt" TIMESTAMP(3),
    "notes" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GlobalFeatureFlag_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GlobalFeatureFlag_key_key" ON "GlobalFeatureFlag"("key");

-- ---------- PlatformSetting ----------
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- ---------- SecurityEvent ----------
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "userId" TEXT,
    "email" TEXT,
    "hotelId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "details" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SecurityEvent_type_idx" ON "SecurityEvent"("type");
CREATE INDEX "SecurityEvent_severity_idx" ON "SecurityEvent"("severity");
CREATE INDEX "SecurityEvent_createdAt_idx" ON "SecurityEvent"("createdAt");

-- ---------- BackupRecord ----------
CREATE TABLE "BackupRecord" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "filename" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "encrypted" BOOLEAN NOT NULL DEFAULT true,
    "storagePath" TEXT,
    "triggeredBy" TEXT,
    "triggerReason" TEXT,
    "error" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BackupRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BackupRecord_status_idx" ON "BackupRecord"("status");
CREATE INDEX "BackupRecord_createdAt_idx" ON "BackupRecord"("createdAt");

-- ---------- PlatformNotificationTemplate ----------
CREATE TABLE "PlatformNotificationTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "variables" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformNotificationTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlatformNotificationTemplate_key_key" ON "PlatformNotificationTemplate"("key");

-- ---------- User: MFA backup codes ----------
ALTER TABLE "User" ADD COLUMN "mfaBackupCodes" TEXT;
ALTER TABLE "User" ADD COLUMN "mfaEnforcedAt" TIMESTAMP(3);

-- ---------- UsageRecord: additional metered resources ----------
ALTER TABLE "UsageRecord" ADD COLUMN "exports" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UsageRecord" ADD COLUMN "restaurants" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UsageRecord" ADD COLUMN "locations" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UsageRecord" ADD COLUMN "whatsappMessages" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UsageRecord" ADD COLUMN "smsMessages" INTEGER NOT NULL DEFAULT 0;

-- ---------- Hotel relation for payments ----------
-- (Foreign-key index above covers Payment_hotelId; the relation itself is
-- declared in the Prisma schema — Postgres needs no extra DDL here.)

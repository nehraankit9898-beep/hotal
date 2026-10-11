-- Phase 18 — Advanced AI & Innovation migration (PostgreSQL)
-- Additive only. Every statement is IF NOT EXISTS / guard-checked so this
-- migration is safe on a partially-migrated installation and re-runnable.
-- No data backfill required: all new tables start empty and every AI feature
-- is OFF by default (AISettings row is created lazily on first use).
-- Rollback: drop the 7 tables (in reverse dependency order):
--   "SustainabilityBadge", "WalletPass", "AIRecommendation", "DemandForecast",
--   "AIInteractionLog", "AIConversation", "AISettings".
-- No existing table/column is altered destructively.

-- ---------------------------------------------------------------------------
-- 1. AISettings — per-tenant AI feature flags & budget caps (default OFF)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "AISettings" (
    "id"                    TEXT NOT NULL,
    "hotelId"               TEXT NOT NULL,
    "chatbotEnabled"        BOOLEAN NOT NULL DEFAULT false,
    "chatbotServiceHours"   TEXT,
    "recommendationsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "forecastingEnabled"    BOOLEAN NOT NULL DEFAULT false,
    "voiceEnabled"          BOOLEAN NOT NULL DEFAULT false,
    "walletEnabled"         BOOLEAN NOT NULL DEFAULT false,
    "sustainabilityEnabled" BOOLEAN NOT NULL DEFAULT false,
    "modelProvider"         TEXT NOT NULL DEFAULT 'NONE',
    "dailyRequestCap"       INTEGER NOT NULL DEFAULT 200,
    "monthlyRequestCap"     INTEGER NOT NULL DEFAULT 3000,
    "handoffPhone"          TEXT,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AISettings_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "AISettings" ADD CONSTRAINT "AISettings_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "AISettings_hotelId_key" ON "AISettings"("hotelId");
CREATE INDEX IF NOT EXISTS "AISettings_hotelId_idx" ON "AISettings"("hotelId");

-- ---------------------------------------------------------------------------
-- 2. AIConversation — WhatsApp chatbot conversation state
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "AIConversation" (
    "id"             TEXT NOT NULL,
    "hotelId"        TEXT NOT NULL,
    "phone"          TEXT NOT NULL,
    "customerId"     TEXT,
    "state"          TEXT NOT NULL DEFAULT 'IDLE',
    "cartJson"       TEXT,
    "lastOrderId"    TEXT,
    "lastInboundId"  TEXT,
    "messageCount"   INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AIConversation_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "AIConversation" ADD CONSTRAINT "AIConversation_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "AIConversation" ADD CONSTRAINT "AIConversation_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "AIConversation_hotelId_phone_key" ON "AIConversation"("hotelId", "phone");
CREATE UNIQUE INDEX IF NOT EXISTS "AIConversation_lastInboundId_key" ON "AIConversation"("lastInboundId");
CREATE INDEX IF NOT EXISTS "AIConversation_hotelId_state_idx" ON "AIConversation"("hotelId", "state");
CREATE INDEX IF NOT EXISTS "AIConversation_lastActivityAt_idx" ON "AIConversation"("lastActivityAt");

-- ---------------------------------------------------------------------------
-- 3. AIInteractionLog — governance audit (no raw prompts, no secrets)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "AIInteractionLog" (
    "id"         TEXT NOT NULL,
    "hotelId"    TEXT NOT NULL,
    "kind"       TEXT NOT NULL,
    "subtype"    TEXT,
    "channel"    TEXT,
    "status"     TEXT NOT NULL,
    "reason"     TEXT,
    "customerId" TEXT,
    "metaJson"   TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AIInteractionLog_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "AIInteractionLog" ADD CONSTRAINT "AIInteractionLog_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "AIInteractionLog_hotelId_createdAt_idx" ON "AIInteractionLog"("hotelId", "createdAt");
CREATE INDEX IF NOT EXISTS "AIInteractionLog_hotelId_kind_status_idx" ON "AIInteractionLog"("hotelId", "kind", "status");

-- ---------------------------------------------------------------------------
-- 4. DemandForecast — advisory-only forecast per item per business day
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "DemandForecast" (
    "id"          TEXT NOT NULL,
    "hotelId"     TEXT NOT NULL,
    "menuItemId"  TEXT,
    "businessDate" TEXT NOT NULL,
    "dow"         INTEGER NOT NULL,
    "forecastQty" DOUBLE PRECISION NOT NULL,
    "lowerBound"  DOUBLE PRECISION NOT NULL,
    "upperBound"  DOUBLE PRECISION NOT NULL,
    "method"      TEXT NOT NULL DEFAULT 'WEEKDAY_MOVING_AVG',
    "dataPoints"  INTEGER NOT NULL DEFAULT 0,
    "sufficient"  BOOLEAN NOT NULL DEFAULT false,
    "mae"         DOUBLE PRECISION,
    "naiveMae"    DOUBLE PRECISION,
    "computedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DemandForecast_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "DemandForecast" ADD CONSTRAINT "DemandForecast_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "DemandForecast" ADD CONSTRAINT "DemandForecast_menuItemId_fkey"
    FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "DemandForecast_hotelId_menuItemId_businessDate_key"
    ON "DemandForecast"("hotelId", "menuItemId", "businessDate");
CREATE INDEX IF NOT EXISTS "DemandForecast_hotelId_businessDate_idx" ON "DemandForecast"("hotelId", "businessDate");

-- ---------------------------------------------------------------------------
-- 5. AIRecommendation — rule-based offers requiring human approval
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "AIRecommendation" (
    "id"               TEXT NOT NULL,
    "hotelId"          TEXT NOT NULL,
    "customerId"       TEXT,
    "couponId"         TEXT,
    "basis"            TEXT NOT NULL DEFAULT 'RULE_BASED',
    "ruleId"           TEXT NOT NULL,
    "reasonCode"       TEXT NOT NULL,
    "score"            DOUBLE PRECISION,
    "status"           TEXT NOT NULL DEFAULT 'PENDING',
    "channel"          TEXT NOT NULL DEFAULT 'WHATSAPP',
    "occurrenceKey"    TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "approvedAt"       TIMESTAMP(3),
    "sentAt"           TIMESTAMP(3),
    "errorMessage"     TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AIRecommendation_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "AIRecommendation" ADD CONSTRAINT "AIRecommendation_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "AIRecommendation" ADD CONSTRAINT "AIRecommendation_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "AIRecommendation" ADD CONSTRAINT "AIRecommendation_couponId_fkey"
    FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "AIRecommendation_hotelId_customerId_ruleId_occurrenceKey_key"
    ON "AIRecommendation"("hotelId", "customerId", "ruleId", "occurrenceKey");
CREATE INDEX IF NOT EXISTS "AIRecommendation_hotelId_status_idx" ON "AIRecommendation"("hotelId", "status");
CREATE INDEX IF NOT EXISTS "AIRecommendation_hotelId_createdAt_idx" ON "AIRecommendation"("hotelId", "createdAt");

-- ---------------------------------------------------------------------------
-- 6. WalletPass — digital loyalty wallet pass record (loyalty credential,
--    never a stored-money payment instrument)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "WalletPass" (
    "id"            TEXT NOT NULL,
    "hotelId"       TEXT NOT NULL,
    "customerId"    TEXT NOT NULL,
    "serialNumber"  TEXT NOT NULL,
    "platform"      TEXT NOT NULL DEFAULT 'GENERIC',
    "status"        TEXT NOT NULL DEFAULT 'ACTIVE',
    "pointsAtIssue" INTEGER NOT NULL DEFAULT 0,
    "updateToken"   TEXT NOT NULL,
    "issuedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"     TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WalletPass_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "WalletPass" ADD CONSTRAINT "WalletPass_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "WalletPass" ADD CONSTRAINT "WalletPass_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "WalletPass_serialNumber_key" ON "WalletPass"("serialNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "WalletPass_updateToken_key" ON "WalletPass"("updateToken");
CREATE UNIQUE INDEX IF NOT EXISTS "WalletPass_hotelId_customerId_platform_key"
    ON "WalletPass"("hotelId", "customerId", "platform");
CREATE INDEX IF NOT EXISTS "WalletPass_hotelId_status_idx" ON "WalletPass"("hotelId", "status");

-- ---------------------------------------------------------------------------
-- 7. SustainabilityBadge — self-reported badges (labelled on display)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "SustainabilityBadge" (
    "id"          TEXT NOT NULL,
    "hotelId"     TEXT NOT NULL,
    "label"       TEXT NOT NULL,
    "description" TEXT,
    "source"      TEXT NOT NULL DEFAULT 'SELF_REPORTED',
    "methodRef"   TEXT,
    "active"      BOOLEAN NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SustainabilityBadge_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "SustainabilityBadge" ADD CONSTRAINT "SustainabilityBadge_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "SustainabilityBadge_hotelId_active_idx" ON "SustainabilityBadge"("hotelId", "active");

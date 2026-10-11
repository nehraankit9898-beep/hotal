-- Recheck release migration (0004)
--
-- The previous release changed prisma/schema.postgres.prisma (new enum values,
-- MessageTemplate binding columns, PhoneOtp table) but shipped NO migration —
-- production `prisma migrate deploy` never applied those changes, so SQLite
-- `db push` tests passed while a real PostgreSQL deployment was missing the
-- new table/columns/enum values (integration save, OTP and message-state
-- writes would fail after deployment).
--
-- This migration closes that drift, verified against a schema-to-schema diff
-- (evidence: required-migration.sql) PLUS the Campaign template binding added
-- in this release:
--   1. MessageStatus UNKNOWN / RETRYING            (F07 — delivery honesty)
--   2. IntegrationStatus SAVED_UNVERIFIED / VERIFIED (F04 — honest states)
--   3. MessageTemplate provider binding columns    (F03 — WhatsApp templates)
--   4. PhoneOtp table + indexes                    (F14 — phone ownership)
--   5. Campaign.messageTemplateId (+ FK + index)   (recheck fix D)
--
-- PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE inside a transaction; the
-- bundled production database is postgres:16.

-- ---------- 1. MessageStatus: UNKNOWN / RETRYING ----------
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'UNKNOWN';
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'RETRYING';

-- ---------- 2. IntegrationStatus: SAVED_UNVERIFIED / VERIFIED ----------
ALTER TYPE "IntegrationStatus" ADD VALUE IF NOT EXISTS 'SAVED_UNVERIFIED';
ALTER TYPE "IntegrationStatus" ADD VALUE IF NOT EXISTS 'VERIFIED';

-- ---------- 3. MessageTemplate provider binding (F03) ----------
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "providerTemplateId" TEXT;
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "languageCode" TEXT;
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "variableMap" TEXT;
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "approvalStatus" TEXT;

-- ---------- 4. PhoneOtp (F14) ----------
CREATE TABLE IF NOT EXISTS "PhoneOtp" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'PUBLIC_JOIN',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhoneOtp_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PhoneOtp_hotelId_phone_idx" ON "PhoneOtp"("hotelId", "phone");
CREATE INDEX IF NOT EXISTS "PhoneOtp_expiresAt_idx" ON "PhoneOtp"("expiresAt");
CREATE UNIQUE INDEX IF NOT EXISTS "PhoneOtp_hotelId_phone_purpose_key" ON "PhoneOtp"("hotelId", "phone", "purpose");

-- ---------- 5. Campaign template binding (recheck fix D) ----------
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "messageTemplateId" TEXT;
CREATE INDEX IF NOT EXISTS "Campaign_messageTemplateId_idx" ON "Campaign"("messageTemplateId");
DO $$
BEGIN
   IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'Campaign_messageTemplateId_fkey'
   ) THEN
      ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_messageTemplateId_fkey"
        FOREIGN KEY ("messageTemplateId") REFERENCES "MessageTemplate"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
   END IF;
END $$;

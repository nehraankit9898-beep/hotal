-- Phase 17 — Enterprise & Platform Completion migration (PostgreSQL)
-- Additive only. Every statement is IF NOT EXISTS / guard-checked so this
-- migration is safe on a partially-migrated installation and re-runnable.
-- No data backfill required. No existing table/column is altered destructively.

-- ---------------------------------------------------------------------------
-- 1. Franchise / chain hierarchy
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "FranchiseOrganization" (
    "id"              TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "legalName"       TEXT,
    "taxId"           TEXT,
    "currency"        TEXT NOT NULL DEFAULT 'INR',
    "timezone"        TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "active"          BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FranchiseOrganization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FranchiseOrganizationAdmin" (
    "id"      TEXT NOT NULL,
    "orgId"   TEXT NOT NULL,
    "userId"  TEXT NOT NULL,
    "role"    TEXT NOT NULL DEFAULT 'CENTRAL_ADMIN',
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FranchiseOrganizationAdmin_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FranchiseOrganizationAdmin_orgId_userId_key"
    ON "FranchiseOrganizationAdmin"("orgId", "userId");
CREATE INDEX IF NOT EXISTS "FranchiseOrganizationAdmin_userId_idx"
    ON "FranchiseOrganizationAdmin"("userId");

DO $$ BEGIN
    ALTER TABLE "FranchiseOrganizationAdmin"
        ADD CONSTRAINT "FranchiseOrganizationAdmin_orgId_fkey"
        FOREIGN KEY ("orgId") REFERENCES "FranchiseOrganization"("id")
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "CentralMenuTemplate" (
    "id"              TEXT NOT NULL,
    "orgId"           TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "version"         INTEGER NOT NULL DEFAULT 1,
    "active"          BOOLEAN NOT NULL DEFAULT true,
    "publishedAt"     TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CentralMenuTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CentralMenuTemplate_orgId_active_idx"
    ON "CentralMenuTemplate"("orgId", "active");

DO $$ BEGIN
    ALTER TABLE "CentralMenuTemplate"
        ADD CONSTRAINT "CentralMenuTemplate_orgId_fkey"
        FOREIGN KEY ("orgId") REFERENCES "FranchiseOrganization"("id")
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "CentralMenuTemplateItem" (
    "id"            TEXT NOT NULL,
    "templateId"    TEXT NOT NULL,
    "externalCode"  TEXT,
    "name"          TEXT NOT NULL,
    "description"   TEXT,
    "priceMinor"    INTEGER NOT NULL,
    "currency"      TEXT NOT NULL DEFAULT 'INR',
    "categoryLabel" TEXT,
    "dietaryTags"   TEXT,
    "sortOrder"     INTEGER NOT NULL DEFAULT 0,
    "active"        BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "CentralMenuTemplateItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CentralMenuTemplateItem_templateId_idx"
    ON "CentralMenuTemplateItem"("templateId");
CREATE INDEX IF NOT EXISTS "CentralMenuTemplateItem_templateId_active_idx"
    ON "CentralMenuTemplateItem"("templateId", "active");

DO $$ BEGIN
    ALTER TABLE "CentralMenuTemplateItem"
        ADD CONSTRAINT "CentralMenuTemplateItem_templateId_fkey"
        FOREIGN KEY ("templateId") REFERENCES "CentralMenuTemplate"("id")
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "CentralMenuRollout" (
    "id"              TEXT NOT NULL,
    "orgId"           TEXT NOT NULL,
    "templateId"      TEXT NOT NULL,
    "version"         INTEGER NOT NULL DEFAULT 1,
    "scheduledAt"     TIMESTAMP(3) NOT NULL,
    "appliedAt"       TIMESTAMP(3),
    "completedAt"     TIMESTAMP(3),
    "rolledBackAt"    TIMESTAMP(3),
    "status"          TEXT NOT NULL DEFAULT 'PENDING',
    "conflictPolicy"  TEXT NOT NULL DEFAULT 'SKIP_OVERWRITE',
    "notes"           TEXT,
    "createdByUserId" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CentralMenuRollout_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CentralMenuRollout_orgId_status_idx"
    ON "CentralMenuRollout"("orgId", "status");
CREATE INDEX IF NOT EXISTS "CentralMenuRollout_templateId_idx"
    ON "CentralMenuRollout"("templateId");

DO $$ BEGIN
    ALTER TABLE "CentralMenuRollout"
        ADD CONSTRAINT "CentralMenuRollout_orgId_fkey"
        FOREIGN KEY ("orgId") REFERENCES "FranchiseOrganization"("id")
        ON DELETE CASCADE;
    ALTER TABLE "CentralMenuRollout"
        ADD CONSTRAINT "CentralMenuRollout_templateId_fkey"
        FOREIGN KEY ("templateId") REFERENCES "CentralMenuTemplate"("id")
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "BranchMenuOverride" (
    "id"              TEXT NOT NULL,
    "hotelId"         TEXT NOT NULL,
    "templateItemId"  TEXT NOT NULL,
    "priceMinor"      INTEGER,
    "currency"        TEXT,
    "available"       BOOLEAN,
    "localName"       TEXT,
    "active"          BOOLEAN NOT NULL DEFAULT true,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BranchMenuOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BranchMenuOverride_hotelId_templateItemId_key"
    ON "BranchMenuOverride"("hotelId", "templateItemId");
CREATE INDEX IF NOT EXISTS "BranchMenuOverride_hotelId_active_idx"
    ON "BranchMenuOverride"("hotelId", "active");

DO $$ BEGIN
    ALTER TABLE "BranchMenuOverride"
        ADD CONSTRAINT "BranchMenuOverride_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE;
    ALTER TABLE "BranchMenuOverride"
        ADD CONSTRAINT "BranchMenuOverride_templateItemId_fkey"
        FOREIGN KEY ("templateItemId") REFERENCES "CentralMenuTemplateItem"("id")
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Update BranchMembership to optionally link to a FranchiseOrganization
ALTER TABLE "BranchMembership" ADD COLUMN IF NOT EXISTS "orgId" TEXT;

DO $$ BEGIN
    ALTER TABLE "BranchMembership"
        ADD CONSTRAINT "BranchMembership_orgId_fkey"
        FOREIGN KEY ("orgId") REFERENCES "FranchiseOrganization"("id")
        ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "BranchMembership_orgId_idx"
    ON "BranchMembership"("orgId");

-- ---------------------------------------------------------------------------
-- 2. White-label / custom domain
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "WhiteLabelConfig" (
    "id"                          TEXT NOT NULL,
    "hotelId"                     TEXT NOT NULL,
    "brandName"                   TEXT,
    "logoUrl"                     TEXT,
    "primaryColor"                TEXT,
    "accentColor"                 TEXT,
    "customDomain"                TEXT,
    "domainVerified"              BOOLEAN NOT NULL DEFAULT false,
    "domainVerificationToken"     TEXT,
    "domainVerifiedAt"            TIMESTAMP(3),
    "removePlatformMarks"         BOOLEAN NOT NULL DEFAULT false,
    "featurePlanGated"            BOOLEAN NOT NULL DEFAULT true,
    "updatedByUserId"             TEXT,
    "createdAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WhiteLabelConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WhiteLabelConfig_hotelId_key"
    ON "WhiteLabelConfig"("hotelId");
CREATE UNIQUE INDEX IF NOT EXISTS "WhiteLabelConfig_customDomain_key"
    ON "WhiteLabelConfig"("customDomain");

DO $$ BEGIN
    ALTER TABLE "WhiteLabelConfig"
        ADD CONSTRAINT "WhiteLabelConfig_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Custom roles
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "CustomRole" (
    "id"              TEXT NOT NULL,
    "hotelId"         TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "description"     TEXT,
    "permissions"     TEXT NOT NULL,
    "isSystemRole"    BOOLEAN NOT NULL DEFAULT false,
    "active"          BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomRole_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomRole_hotelId_name_key"
    ON "CustomRole"("hotelId", "name");
CREATE INDEX IF NOT EXISTS "CustomRole_hotelId_active_idx"
    ON "CustomRole"("hotelId", "active");

DO $$ BEGIN
    ALTER TABLE "CustomRole"
        ADD CONSTRAINT "CustomRole_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "CustomRoleAssignment" (
    "id"           TEXT NOT NULL,
    "customRoleId" TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "assignedBy"   TEXT,
    "assignedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomRoleAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomRoleAssignment_customRoleId_userId_key"
    ON "CustomRoleAssignment"("customRoleId", "userId");
CREATE INDEX IF NOT EXISTS "CustomRoleAssignment_userId_idx"
    ON "CustomRoleAssignment"("userId");

DO $$ BEGIN
    ALTER TABLE "CustomRoleAssignment"
        ADD CONSTRAINT "CustomRoleAssignment_customRoleId_fkey"
        FOREIGN KEY ("customRoleId") REFERENCES "CustomRole"("id")
        ON DELETE CASCADE;
    ALTER TABLE "CustomRoleAssignment"
        ADD CONSTRAINT "CustomRoleAssignment_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Outbound webhooks
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "WebhookEndpoint" (
    "id"        TEXT NOT NULL,
    "hotelId"   TEXT NOT NULL,
    "url"       TEXT NOT NULL,
    "secret"    TEXT NOT NULL,
    "events"    TEXT NOT NULL,
    "active"    BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WebhookEndpoint_hotelId_active_idx"
    ON "WebhookEndpoint"("hotelId", "active");

DO $$ BEGIN
    ALTER TABLE "WebhookEndpoint"
        ADD CONSTRAINT "WebhookEndpoint_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "WebhookDelivery" (
    "id"              TEXT NOT NULL,
    "endpointId"      TEXT NOT NULL,
    "eventId"         TEXT NOT NULL,
    "eventType"       TEXT NOT NULL,
    "payload"         TEXT NOT NULL,
    "signature"       TEXT NOT NULL,
    "attempt"         INTEGER NOT NULL DEFAULT 0,
    "status"          TEXT NOT NULL DEFAULT 'PENDING',
    "responseStatus"  INTEGER,
    "responseSnippet" TEXT,
    "nextRetryAt"     TIMESTAMP(3),
    "deliveredAt"     TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WebhookDelivery_endpointId_status_idx"
    ON "WebhookDelivery"("endpointId", "status");
CREATE INDEX IF NOT EXISTS "WebhookDelivery_nextRetryAt_idx"
    ON "WebhookDelivery"("nextRetryAt");

DO $$ BEGIN
    ALTER TABLE "WebhookDelivery"
        ADD CONSTRAINT "WebhookDelivery_endpointId_fkey"
        FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id")
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 5. A/B experiments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "ABExperiment" (
    "id"              TEXT NOT NULL,
    "key"             TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "description"     TEXT,
    "variants"        TEXT NOT NULL,
    "weights"         TEXT NOT NULL,
    "active"          BOOLEAN NOT NULL DEFAULT false,
    "startedAt"       TIMESTAMP(3),
    "endedAt"         TIMESTAMP(3),
    "killSwitch"      BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ABExperiment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ABExperiment_key_key"
    ON "ABExperiment"("key");

CREATE TABLE IF NOT EXISTS "ABAssignment" (
    "id"            TEXT NOT NULL,
    "experimentId"  TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "variant"       TEXT NOT NULL,
    "assignedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ABAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ABAssignment_experimentId_userId_key"
    ON "ABAssignment"("experimentId", "userId");
CREATE INDEX IF NOT EXISTS "ABAssignment_experimentId_variant_idx"
    ON "ABAssignment"("experimentId", "variant");

DO $$ BEGIN
    ALTER TABLE "ABAssignment"
        ADD CONSTRAINT "ABAssignment_experimentId_fkey"
        FOREIGN KEY ("experimentId") REFERENCES "ABExperiment"("id")
        ON DELETE CASCADE;
    ALTER TABLE "ABAssignment"
        ADD CONSTRAINT "ABAssignment_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Privacy / data subject requests
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "PrivacyRequest" (
    "id"                 TEXT NOT NULL,
    "hotelId"            TEXT NOT NULL,
    "type"               TEXT NOT NULL,
    "status"             TEXT NOT NULL DEFAULT 'PENDING',
    "requestedBy"        TEXT,
    "approvedBy"         TEXT,
    "legalReviewBy"      TEXT,
    "retentionExpiresAt" TIMESTAMP(3),
    "completedAt"        TIMESTAMP(3),
    "rejectionReason"    TEXT,
    "auditSummary"       TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PrivacyRequest_hotelId_status_idx"
    ON "PrivacyRequest"("hotelId", "status");

DO $$ BEGIN
    ALTER TABLE "PrivacyRequest"
        ADD CONSTRAINT "PrivacyRequest_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 7. SaaS finance: subscription mandates & refunds
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "SubscriptionMandate" (
    "id"                 TEXT NOT NULL,
    "hotelId"            TEXT NOT NULL,
    "provider"           TEXT NOT NULL,
    "providerMandateId"  TEXT NOT NULL,
    "status"             TEXT NOT NULL DEFAULT 'ACTIVE',
    "maxAmountMinor"     INTEGER,
    "currency"           TEXT NOT NULL DEFAULT 'INR',
    "startedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pausedAt"           TIMESTAMP(3),
    "cancelledAt"        TIMESTAMP(3),
    "failureReason"      TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SubscriptionMandate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SubscriptionMandate_providerMandateId_key"
    ON "SubscriptionMandate"("providerMandateId");
CREATE INDEX IF NOT EXISTS "SubscriptionMandate_hotelId_status_idx"
    ON "SubscriptionMandate"("hotelId", "status");

DO $$ BEGIN
    ALTER TABLE "SubscriptionMandate"
        ADD CONSTRAINT "SubscriptionMandate_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "SubscriptionRefund" (
    "id"               TEXT NOT NULL,
    "hotelId"          TEXT NOT NULL,
    "paymentId"        TEXT,
    "providerRefundId" TEXT,
    "amountMinor"      INTEGER NOT NULL,
    "currency"         TEXT NOT NULL DEFAULT 'INR',
    "status"           TEXT NOT NULL DEFAULT 'PENDING',
    "reason"           TEXT,
    "failureReason"    TEXT,
    "initiatedBy"      TEXT,
    "idempotencyKey"   TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SubscriptionRefund_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SubscriptionRefund_providerRefundId_key"
    ON "SubscriptionRefund"("providerRefundId");
CREATE UNIQUE INDEX IF NOT EXISTS "SubscriptionRefund_idempotencyKey_key"
    ON "SubscriptionRefund"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "SubscriptionRefund_hotelId_status_idx"
    ON "SubscriptionRefund"("hotelId", "status");

DO $$ BEGIN
    ALTER TABLE "SubscriptionRefund"
        ADD CONSTRAINT "SubscriptionRefund_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 8. Currency rates & competitor benchmark
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "CurrencyRate" (
    "id"       TEXT NOT NULL,
    "base"     TEXT NOT NULL,
    "quote"    TEXT NOT NULL,
    "rate"     DOUBLE PRECISION NOT NULL,
    "datedAt"  TIMESTAMP(3) NOT NULL,
    "source"   TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CurrencyRate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CurrencyRate_base_quote_datedAt_key"
    ON "CurrencyRate"("base", "quote", "datedAt");
CREATE INDEX IF NOT EXISTS "CurrencyRate_base_quote_idx"
    ON "CurrencyRate"("base", "quote");

CREATE TABLE IF NOT EXISTS "CompetitorBenchmark" (
    "id"           TEXT NOT NULL,
    "hotelId"      TEXT NOT NULL,
    "source"       TEXT NOT NULL,
    "metricKey"    TEXT NOT NULL,
    "metricValue"  DOUBLE PRECISION NOT NULL,
    "confidence"   TEXT NOT NULL DEFAULT 'MEDIUM',
    "coverageNote" TEXT,
    "observedAt"   TIMESTAMP(3) NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompetitorBenchmark_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CompetitorBenchmark_hotelId_metricKey_idx"
    ON "CompetitorBenchmark"("hotelId", "metricKey");

DO $$ BEGIN
    ALTER TABLE "CompetitorBenchmark"
        ADD CONSTRAINT "CompetitorBenchmark_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 9. Secret rotation audit
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "SecretRotation" (
    "id"          TEXT NOT NULL,
    "secretKey"   TEXT NOT NULL,
    "reason"      TEXT NOT NULL,
    "performedBy" TEXT,
    "beforeHash"  TEXT,
    "afterHash"   TEXT,
    "rotatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes"       TEXT,
    CONSTRAINT "SecretRotation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SecretRotation_secretKey_idx"
    ON "SecretRotation"("secretKey");
CREATE INDEX IF NOT EXISTS "SecretRotation_rotatedAt_idx"
    ON "SecretRotation"("rotatedAt");

-- End of Phase 17 migration.

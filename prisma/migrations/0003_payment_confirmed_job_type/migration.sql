-- Phase 10 audit fix (billing-1): outbox job type for payment confirmation
-- follow-up (coupon redemption + subscription activation recovery).
--
-- Adding an enum VALUE is non-destructive: existing rows keep their type and
-- every existing query/filter continues to work unchanged. PostgreSQL 12+
-- allows ALTER TYPE ... ADD VALUE inside the transaction migrate deploy uses;
-- the bundled production database is postgres:16.
ALTER TYPE "BackgroundJobType" ADD VALUE 'PAYMENT_CONFIRMED';

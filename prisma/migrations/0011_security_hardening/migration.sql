-- Security hardening (PostgreSQL) — additive only, re-runnable.
--
-- 1. User.mfaLastUsedStep: TOTP replay protection. Stores the last accepted
--    time-step so a valid code cannot be replayed within its ±1 window.
-- 2. AuthAttempt(ipAddress, createdAt): the per-IP throttle filters on these two
--    columns on every login; without this index that is a full-table scan.
--
-- Rollback: DROP INDEX IF EXISTS "AuthAttempt_ipAddress_createdAt_idx";
--           ALTER TABLE "User" DROP COLUMN IF EXISTS "mfaLastUsedStep";

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaLastUsedStep" INTEGER;

CREATE INDEX IF NOT EXISTS "AuthAttempt_ipAddress_createdAt_idx" ON "AuthAttempt"("ipAddress", "createdAt");

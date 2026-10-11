-- Migration 0008 — Audit bugfixes (PostgreSQL — production source of truth).
-- Part of the phase 11/12/14/15/16 bug audit:
--   * JourneyDeliveryStatus gains an APPENDED 'SENDING' value used as the
--     pre-send CAS claim so concurrent workers can never double-deliver a
--     journey step (see src/lib/scheduler.ts, AUDIT FIX P11-JRN-1).
--
-- Safe upgrade path: ADD VALUE IF NOT EXISTS at the end of the enum
-- (PostgreSQL cannot insert enum values in the middle). Existing rows and
-- indexes are untouched; the new value is inert until the app writes it.
--
-- Rollback: app code falls back gracefully if the value is unused; the enum
-- value itself cannot be portably removed from PostgreSQL.

ALTER TYPE "JourneyDeliveryStatus" ADD VALUE IF NOT EXISTS 'SENDING';

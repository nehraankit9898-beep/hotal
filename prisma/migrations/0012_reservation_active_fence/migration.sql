-- Reservation slot fence (PostgreSQL) — re-runnable.
--
-- BUG FIX: the unconditional unique index on ("tableId", "date", "startTime")
-- also covered CANCELLED / NO_SHOW / COMPLETED rows, so once a reservation was
-- cancelled nobody could ever book that table at that date and start time
-- again (the overlap check ignores inactive rows; the insert then hit the
-- unique index and was rejected as a slot conflict).
--
-- "activeFence" is 1 while a reservation is ACTIVE and NULL once it becomes
-- inactive; NULLs are distinct in unique indexes, so only ACTIVE reservations
-- compete for a slot (same pattern as TableSession."openFence").
--
-- Rollback (only valid while no inactive slot has been re-booked):
--   DROP INDEX IF EXISTS "Reservation_tableId_date_startTime_activeFence_key";
--   CREATE UNIQUE INDEX IF NOT EXISTS "Reservation_tableId_date_startTime_key" ON "Reservation"("tableId", "date", "startTime");
--   ALTER TABLE "Reservation" DROP COLUMN IF EXISTS "activeFence";

ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "activeFence" INTEGER DEFAULT 1;

UPDATE "Reservation" SET "activeFence" = NULL
WHERE "status" IN ('CANCELLED', 'NO_SHOW', 'COMPLETED') AND "activeFence" IS NOT NULL;

DROP INDEX IF EXISTS "Reservation_tableId_date_startTime_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Reservation_tableId_date_startTime_activeFence_key" ON "Reservation"("tableId", "date", "startTime", "activeFence");

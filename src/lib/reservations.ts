/**
 * Phase 16 — table reservations.
 *
 * CONCURRENCY SAFETY: booking runs inside a transaction that re-checks
 * overlapping ACTIVE reservations for the same table; the DB-level
 * (tableId, date, startTime, activeFence) unique index is the final fence.
 * Two concurrent requests for the same slot can never both win — the loser
 * gets a clear CONFLICT response. activeFence is 1 only while a reservation
 * is ACTIVE, so cancelled / no-show / completed rows never block a slot.
 * Party capacity is checked against the hotel's reservationMaxPartySize
 * setting.
 *
 * Time model: local business date "YYYY-MM-DD" + "HH:MM" strings in the
 * TENANT timezone (matches the financial-day convention from Phase 14);
 * overlap math is done in minutes-of-day on the same local date.
 */

import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";

const ACTIVE_STATUSES = ["PENDING", "CONFIRMED", "SEATED"] as const;

export function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export function overlaps(aStart: string, aDur: number, bStart: string, bDur: number): boolean {
  const a0 = timeToMinutes(aStart);
  const a1 = a0 + aDur;
  const b0 = timeToMinutes(bStart);
  const b1 = b0 + bDur;
  return a0 < b1 && b0 < a1;
}

export interface CreateReservationInput {
  hotelId: string;
  tableId?: string | null;
  date: string;
  startTime: string;
  durationMinutes?: number;
  partySize: number;
  guestName: string;
  guestPhone: string;
  notes?: string | null;
  source?: "STAFF" | "PUBLIC";
  createdByUserId?: string | null;
  /** Auto-confirm staff bookings; public requests stay PENDING. */
  autoConfirm?: boolean;
}

export class ReservationConflictError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * BUG FIX (API contract): malformed input used to be thrown as a
 * ReservationConflictError, so a payload with a wrong date/time format or a
 * non-positive party size was answered with `409 SLOT_CONFLICT` — the code
 * that means "that table slot is already taken". Clients (and the booking UI)
 * could not tell a typo apart from a real double-booking. Shape/type problems
 * are now a distinct error the route maps to `422 VALIDATION_ERROR`; genuine
 * availability and policy conflicts stay 409.
 */
export class ReservationValidationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export async function createReservation(input: CreateReservationInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new ReservationValidationError("date must be YYYY-MM-DD (tenant-local).");
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime)) {
    throw new ReservationValidationError("startTime must be HH:MM (tenant-local).");
  }
  const partySize = Math.floor(input.partySize);
  if (!Number.isFinite(partySize) || partySize <= 0) {
    throw new ReservationValidationError("partySize must be a positive integer.");
  }
  const duration = Math.min(Math.max(Math.floor(input.durationMinutes ?? 90), 30), 300);

  const hotel = await db.hotel.findUnique({ where: { id: input.hotelId }, select: { status: true } });
  if (!hotel || hotel.status !== "ACTIVE") {
    throw new ReservationConflictError("This restaurant is not accepting reservations.");
  }
  const settings = await db.hotelSettings.findUnique({ where: { hotelId: input.hotelId } });
  if (partySize > (settings?.reservationMaxPartySize ?? 20)) {
    throw new ReservationConflictError(`Party size above the maximum (${settings?.reservationMaxPartySize ?? 20}).`);
  }
  if (input.tableId) {
    const table = await db.diningTable.findFirst({ where: { id: input.tableId, hotelId: input.hotelId, active: true } });
    if (!table) throw new ReservationConflictError("Table not found.");
    // AUDIT FIX (P16-RSV-1): only a hotel-wide party cap was enforced — a
    // party of 12 could book a 2-top. Per-table capacity is also binding.
    if (partySize > table.capacity) {
      throw new ReservationConflictError(`That table seats ${table.capacity} guests — party of ${partySize} will not fit.`);
    }
  }

  try {
    return await db.$transaction(
      async (tx) => {
        if (input.tableId) {
          // Overlap re-check INSIDE the transaction (SQLite serializes writes;
          // on PostgreSQL the unique index below is the authoritative fence).
          const sameDay = await tx.reservation.findMany({
            where: {
              hotelId: input.hotelId,
              tableId: input.tableId,
              date: input.date,
              status: { in: [...ACTIVE_STATUSES] },
            },
            select: { startTime: true, durationMinutes: true },
          });
          for (const r of sameDay) {
            if (overlaps(input.startTime, duration, r.startTime, r.durationMinutes)) {
              throw new ReservationConflictError("That table is already reserved for an overlapping time.");
            }
          }
        }
        return tx.reservation.create({
          data: {
            hotelId: input.hotelId,
            tableId: input.tableId ?? null,
            date: input.date,
            startTime: input.startTime,
            durationMinutes: duration,
            partySize,
            status: input.autoConfirm ? "CONFIRMED" : "PENDING",
            guestName: input.guestName.slice(0, 120),
            guestPhone: input.guestPhone.slice(0, 20),
            notes: input.notes?.slice(0, 500) ?? null,
            source: input.source ?? "STAFF",
            createdByUserId: input.createdByUserId ?? null,
            activeFence: 1,
          },
        });
      },
      { timeout: 30_000 },
    );
  } catch (err) {
    // Unique fence: (tableId, date, startTime, activeFence) — the concurrent loser lands here.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      throw new ReservationConflictError("That table is already reserved for this slot.");
    }
    throw err;
  }
}

/** Staff lifecycle transitions with audit. */
export async function transitionReservation(
  hotelId: string,
  reservationId: string,
  to: "CONFIRMED" | "SEATED" | "CANCELLED" | "NO_SHOW" | "COMPLETED",
  actorUserId: string,
  cancelReason?: string,
) {
  const ALLOWED: Record<string, string[]> = {
    PENDING: ["CONFIRMED", "CANCELLED", "NO_SHOW"],
    CONFIRMED: ["SEATED", "CANCELLED", "NO_SHOW", "COMPLETED"],
    SEATED: ["COMPLETED", "CANCELLED"],
    CANCELLED: [],
    NO_SHOW: [],
    COMPLETED: [],
  };
  const reservation = await db.reservation.findFirst({ where: { id: reservationId, hotelId } });
  if (!reservation) return { ok: false as const, reason: "Reservation not found." };
  if (!ALLOWED[reservation.status].includes(to)) {
    return { ok: false as const, reason: `Cannot move a ${reservation.status.toLowerCase()} reservation to ${to.toLowerCase()}.` };
  }
  if ((to === "CANCELLED" || to === "NO_SHOW") && !cancelReason && to === "CANCELLED") {
    return { ok: false as const, reason: "A reason is required to cancel." };
  }

  // AUDIT FIX (P16-RSV-2): the update was not status-conditional — two
  // concurrent transitions both succeeded (last-writer-wins) with two audit
  // rows. The state machine is now enforced at the DB level: the update only
  // lands while the row is still in the observed FROM state.
  const updated = await db.reservation.updateMany({
    where: { id: reservationId, hotelId, status: reservation.status },
    data: {
      status: to,
      confirmedByUserId: to === "CONFIRMED" ? actorUserId : reservation.confirmedByUserId,
      seatedAt: to === "SEATED" ? new Date() : reservation.seatedAt,
      cancelledAt: to === "CANCELLED" ? new Date() : reservation.cancelledAt,
      cancelReason: to === "CANCELLED" ? (cancelReason ?? reservation.cancelReason) : reservation.cancelReason,
      // BUG FIX: inactive reservations kept holding the (tableId, date,
      // startTime) unique slot, so a cancelled slot could never be re-booked.
      activeFence: (ACTIVE_STATUSES as readonly string[]).includes(to) ? 1 : null,
    },
  });
  if (updated.count !== 1) {
    return { ok: false as const, reason: "Reservation was just updated by someone else — reload and retry." };
  }
  const fresh = await db.reservation.findUnique({ where: { id: reservationId } });
  await logAudit({
    hotelId,
    userId: actorUserId,
    action: "RESERVATION_UPDATED",
    entityType: "Reservation",
    entityId: reservationId,
    metadata: { from: reservation.status, to, reason: cancelReason ?? null },
  });
  return { ok: true as const, reservation: fresh ?? reservation };
}

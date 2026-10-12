import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import {
  createReservation,
  transitionReservation,
  ReservationConflictError,
  ReservationValidationError,
} from "@/lib/reservations";

/**
 * Phase 16 — reservations (staff side).
 *
 * GET  /api/reservations?date=YYYY-MM-DD&status= — day/status list
 * POST /api/reservations — staff booking (auto-confirmed)
 *   { tableId?, date, startTime, durationMinutes?, partySize,
 *     guestName, guestPhone, notes? }
 * PATCH /api/reservations — { id, to, reason? } lifecycle transition
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "RESERVATION_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const date = url.searchParams.get("date");
    const status = url.searchParams.get("status");
    const reservations = await db.reservation.findMany({
      where: {
        hotelId: auth.user.hotelId,
        ...(date ? { date } : {}),
        ...(status ? { status: status as never } : {}),
      },
      orderBy: [{ date: "asc" }, { startTime: "asc" }],
      take: 200,
      include: { table: { select: { id: true, number: true, zone: true, capacity: true } } },
    });
    return Response.json({ reservations });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "RESERVATION_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");
    const guestName = typeof body.guestName === "string" ? body.guestName.trim() : "";
    const guestPhone = typeof body.guestPhone === "string" ? body.guestPhone.trim() : "";
    if (guestName.length < 2) return jsonError("Guest name is required.", 422, "INVALID_GUEST");
    if (guestPhone.replace(/\D/g, "").length < 8) return jsonError("A valid guest phone is required.", 422, "INVALID_PHONE");

    try {
      const reservation = await createReservation({
        hotelId: auth.user.hotelId!,
        tableId: typeof body.tableId === "string" ? body.tableId : null,
        date: typeof body.date === "string" ? body.date : "",
        startTime: typeof body.startTime === "string" ? body.startTime : "",
        durationMinutes: typeof body.durationMinutes === "number" ? body.durationMinutes : 90,
        partySize: Number(body.partySize),
        guestName,
        guestPhone,
        notes: typeof body.notes === "string" ? body.notes : null,
        source: "STAFF",
        createdByUserId: auth.user.userId,
        autoConfirm: true,
      });
      return Response.json({ reservation }, { status: 201 });
    } catch (err) {
      if (err instanceof ReservationValidationError) {
        return jsonError(err.message, 422, "VALIDATION_ERROR");
      }
      if (err instanceof ReservationConflictError) {
        return jsonError(err.message, 409, "SLOT_CONFLICT");
      }
      throw err;
    }
  } catch (err) {
    return serverError(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "RESERVATION_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");
    const id = typeof body.id === "string" ? body.id : "";
    const to = body.to;
    if (!id || typeof to !== "string" || !["CONFIRMED", "SEATED", "CANCELLED", "NO_SHOW", "COMPLETED"].includes(to)) {
      return jsonError("Expected { id, to, reason? } with a valid target status.", 422, "INVALID_TRANSITION");
    }
    const result = await transitionReservation(
      auth.user.hotelId!,
      id,
      to as "CONFIRMED" | "SEATED" | "CANCELLED" | "NO_SHOW" | "COMPLETED",
      auth.user.userId,
      typeof body.reason === "string" ? body.reason : undefined,
    );
    if (!result.ok) return jsonError(result.reason ?? "Transition rejected.", 422, "TRANSITION_REJECTED");
    return Response.json({ reservation: result.reservation });
  } catch (err) {
    return serverError(err);
  }
}

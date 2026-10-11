import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";

/**
 * Phase 16 — shift assignments.
 * GET  /api/shifts?date= — list
 * POST /api/shifts — { userId, date, startTime, endTime, role?, note? }
 * DELETE /api/shifts?id= — remove
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "ATTENDANCE_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const date = url.searchParams.get("date");
    const shifts = await db.shiftAssignment.findMany({
      where: { hotelId: auth.user.hotelId, ...(date ? { date } : {}) },
      orderBy: [{ date: "asc" }, { startTime: "asc" }],
      take: 300,
      include: { user: { select: { id: true, name: true, role: true } } },
    });
    return Response.json({ shifts });
  } catch (err) {
    return serverError(err);
  }
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "ATTENDANCE_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");
    const userId = typeof body.userId === "string" ? body.userId : "";
    const date = typeof body.date === "string" ? body.date : "";
    const startTime = typeof body.startTime === "string" ? body.startTime : "";
    const endTime = typeof body.endTime === "string" ? body.endTime : "";
    if (!userId) return jsonError("userId is required.", 422, "MISSING_FIELD");
    if (!DATE_RE.test(date) || !TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
      return jsonError("date (YYYY-MM-DD), startTime and endTime (HH:MM) are required.", 422, "INVALID_INPUT");
    }
    const user = await db.user.findFirst({ where: { id: userId, hotelId: auth.user.hotelId } });
    if (!user) return jsonError("Staff user not found.", 404, "NOT_FOUND");

    const shift = await db.shiftAssignment.create({
      data: {
        hotelId: auth.user.hotelId!,
        userId,
        date,
        startTime,
        endTime,
        role: typeof body.role === "string" ? body.role.slice(0, 40) : null,
        note: typeof body.note === "string" ? body.note.slice(0, 300) : null,
      },
      include: { user: { select: { id: true, name: true, role: true } } },
    });
    return Response.json({ shift }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "ATTENDANCE_MANAGE");
    if (denied) return denied;

    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return jsonError("id is required.", 422, "MISSING_FIELD");
    const existing = await db.shiftAssignment.findFirst({ where: { id, hotelId: auth.user.hotelId } });
    if (!existing) return jsonError("Shift not found.", 404, "NOT_FOUND");
    await db.shiftAssignment.delete({ where: { id } });
    return Response.json({ deleted: true });
  } catch (err) {
    return serverError(err);
  }
}

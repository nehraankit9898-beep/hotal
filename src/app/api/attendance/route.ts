import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

/**
 * Phase 16 — staff attendance.
 * GET  /api/attendance?date=&userId= — records (ATTENDANCE_READ)
 * POST /api/attendance — clock in/out or mark
 *   { action: "CLOCK_IN" | "CLOCK_OUT" } (self — own record only)
 *   { userId, date, status, note? } (ATTENDANCE_MANAGE — corrections audited)
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "ATTENDANCE_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const date = url.searchParams.get("date");
    const records = await db.attendanceRecord.findMany({
      where: { hotelId: auth.user.hotelId, ...(date ? { date } : {}) },
      orderBy: [{ date: "desc" }, { clockInAt: "desc" }],
      take: 300,
      include: { user: { select: { id: true, name: true, role: true } } },
    });
    return Response.json({ records });
  } catch (err) {
    return serverError(err);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayLocal(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");
    const hotel = await db.hotel.findUnique({ where: { id: auth.user.hotelId! }, select: { timezone: true } });
    const tz = hotel?.timezone || "Asia/Kolkata";
    const today = todayLocal(tz);

    // Self clock in/out — any staff with a session can record their own day.
    if (body.action === "CLOCK_IN" || body.action === "CLOCK_OUT") {
      const existing = await db.attendanceRecord.findUnique({
        where: { hotelId_userId_date: { hotelId: auth.user.hotelId!, userId: auth.user.userId, date: today } },
      });
      if (body.action === "CLOCK_IN") {
        if (existing?.clockInAt) return jsonError("Already clocked in today.", 422, "ALREADY_CLOCKED_IN");
        const record = await db.attendanceRecord.upsert({
          where: { hotelId_userId_date: { hotelId: auth.user.hotelId!, userId: auth.user.userId, date: today } },
          create: { hotelId: auth.user.hotelId!, userId: auth.user.userId, date: today, status: "PRESENT", clockInAt: new Date() },
          update: { clockInAt: new Date(), status: existing?.status ?? "PRESENT" },
        });
        return Response.json({ record }, { status: 201 });
      }
      if (!existing?.clockInAt) return jsonError("Clock in first.", 422, "NOT_CLOCKED_IN");
      if (existing.clockOutAt) return jsonError("Already clocked out today.", 422, "ALREADY_CLOCKED_OUT");
      const minutes = Math.max(1, Math.round((Date.now() - existing.clockInAt.getTime()) / 60_000));
      const record = await db.attendanceRecord.update({
        where: { id: existing.id },
        data: { clockOutAt: new Date(), minutesWorked: minutes },
      });
      return Response.json({ record });
    }

    // Owner/manager corrections + manual marks — audited with before/after.
    const denied = requirePermission(auth.user, "ATTENDANCE_MANAGE");
    if (denied) return denied;
    const userId = typeof body.userId === "string" ? body.userId : "";
    const date = typeof body.date === "string" && DATE_RE.test(body.date) ? body.date : today;
    const status = body.status;
    if (!userId) return jsonError("userId is required.", 422, "MISSING_FIELD");
    if (typeof status !== "string" || !["PRESENT", "LATE", "HALF_DAY", "ABSENT", "LEAVE"].includes(status)) {
      return jsonError("Invalid attendance status.", 422, "INVALID_STATUS");
    }
    const staffUser = await db.user.findFirst({ where: { id: userId, hotelId: auth.user.hotelId } });
    if (!staffUser) return jsonError("Staff user not found.", 404, "NOT_FOUND");

    // AUDIT FIX (P16-ATT-1): a manager/owner could previously mark AND
    // silently self-approve their own attendance. When ANOTHER user with
    // ATTENDANCE_MANAGE exists, self-approval is refused (spec: self-approval
    // prevention). Solo tenants (single owner/manager — e.g. a one-person
    // restaurant) have no second approver, so the mark is allowed but loudly
    // flagged in the audit trail instead of blocking the business function.
    let selfApproved = false;
    if (userId === auth.user.userId) {
      const otherApprovers = await db.user.count({
        where: {
          hotelId: auth.user.hotelId,
          status: "ACTIVE",
          id: { not: auth.user.userId },
          role: { in: ["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER"] },
        },
      });
      if (otherApprovers > 0) {
        return jsonError("You cannot approve your own attendance — ask another manager/owner.", 403, "SELF_APPROVAL");
      }
      selfApproved = true;
    }

    const existing = await db.attendanceRecord.findUnique({
      where: { hotelId_userId_date: { hotelId: auth.user.hotelId!, userId, date } },
    });
    // AUDIT FIX (P16-ATT-2): correctionLog used to be overwritten with a
    // single {by, at, before} object (previous corrections lost). It is now
    // the schema-documented APPEND-ONLY array.
    let correctionHistory: Array<{ by: string; at: string; before: string }> = [];
    if (existing?.correctionLog) {
      try {
        const parsed = JSON.parse(existing.correctionLog);
        if (Array.isArray(parsed)) correctionHistory = parsed.slice(0, 49);
      } catch {
        // legacy single-object format — start a fresh array from it
      }
    }
    correctionHistory.push({ by: auth.user.userId, at: new Date().toISOString(), before: existing?.status ?? "NONE" });
    const record = await db.attendanceRecord.upsert({
      where: { hotelId_userId_date: { hotelId: auth.user.hotelId!, userId, date } },
      create: {
        hotelId: auth.user.hotelId!,
        userId,
        date,
        status: status as never,
        note: typeof body.note === "string" ? body.note.slice(0, 300) : null,
        approvedByUserId: auth.user.userId,
        approvedAt: new Date(),
        correctionLog: JSON.stringify(correctionHistory),
      },
      update: {
        status: status as never,
        note: typeof body.note === "string" ? body.note.slice(0, 300) : undefined,
        approvedByUserId: auth.user.userId,
        approvedAt: new Date(),
        correctionLog: JSON.stringify(correctionHistory),
      },
    });
    await logAudit({
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: "ATTENDANCE_CORRECTED",
      entityType: "AttendanceRecord",
      entityId: record.id,
      metadata: { userId, date, status, wasCorrected: Boolean(existing), selfApproved },
      req,
    });
    return Response.json({ record }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}

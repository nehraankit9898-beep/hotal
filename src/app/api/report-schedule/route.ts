import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

/**
 * Phase 15 — owner report schedule (daily/weekly digest).
 * GET/PUT /api/report-schedule — one schedule per hotel.
 * { frequency: DAILY|WEEKLY, weekday?: 0-6, hour?: 0-23, recipients: string[], active }
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "REPORT_MANAGE");
    if (denied) return denied;

    let schedule = await db.reportSchedule.findUnique({ where: { hotelId: auth.user.hotelId } });
    if (!schedule) {
      schedule = await db.reportSchedule.create({ data: { hotelId: auth.user.hotelId! } });
    }
    return Response.json({ schedule });
  } catch (err) {
    return serverError(err);
  }
}

export async function PUT(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "REPORT_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");

    const frequency = body.frequency === "WEEKLY" ? "WEEKLY" : body.frequency === "DAILY" ? "DAILY" : null;
    if (!frequency) return jsonError("frequency must be DAILY or WEEKLY.", 422, "INVALID_FREQUENCY");
    if (!Array.isArray(body.recipients)) {
      return jsonError("recipients must be an array of email addresses.", 422, "INVALID_RECIPIENTS");
    }
    const recipients = (body.recipients as unknown[])
      .filter((r): r is string => typeof r === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r))
      .slice(0, 10);
    if (recipients.length === 0) {
      return jsonError("At least one valid recipient email is required.", 422, "INVALID_RECIPIENTS");
    }
    let weekday: number | null = null;
    if (frequency === "WEEKLY") {
      weekday = Number(body.weekday);
      if (!Number.isInteger(weekday) || weekday! < 0 || weekday! > 6) {
        return jsonError("weekday must be 0 (Sun) .. 6 (Sat) for WEEKLY.", 422, "INVALID_WEEKDAY");
      }
    }
    const hour = typeof body.hour === "number" && Number.isInteger(body.hour) && body.hour >= 0 && body.hour <= 23 ? body.hour : 21;

    const data = {
      frequency,
      weekday,
      hour,
      recipients: JSON.stringify(recipients),
      active: body.active !== false,
    };
    await db.reportSchedule.upsert({ where: { hotelId: auth.user.hotelId! }, create: { hotelId: auth.user.hotelId!, ...data }, update: data });
    const schedule = await db.reportSchedule.findUnique({ where: { hotelId: auth.user.hotelId } });
    await logAudit({
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: "REPORT_SCHEDULE_UPDATED",
      entityType: "ReportSchedule",
      entityId: schedule?.id,
      metadata: { frequency, hour, count: recipients.length, active: data.active },
      req,
    });
    return Response.json({ schedule });
  } catch (err) {
    return serverError(err);
  }
}

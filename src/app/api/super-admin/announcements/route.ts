import { NextResponse } from "next/server";
import { readJson, jsonError, serverError, requireSuperAdminSession } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

/**
 * Global announcements — Phase 9 §17 (Super Admin only).
 *   POST /api/super-admin/announcements
 *     { title, message, severity, audience: all|plan|hotels|trial, planKey?, hotelIds? }
 * Creates Notification rows for the targeted hotels — reusing the existing
 * notification infrastructure (never a parallel delivery system).
 */
export async function POST(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const body = await readJson(req);
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    const severity = typeof body?.severity === "string" ? body.severity.toUpperCase() : "INFO";
    const audience = typeof body?.audience === "string" ? body.audience : "all";

    if (title.length < 3 || title.length > 120)
      return jsonError("Title must be 3-120 characters.", 422, "VALIDATION_ERROR");
    if (message.length < 3 || message.length > 2000)
      return jsonError("Message must be 3-2000 characters.", 422, "VALIDATION_ERROR");
    if (!["INFO", "WARNING", "CRITICAL"].includes(severity))
      return jsonError("Severity must be INFO, WARNING or CRITICAL.", 422, "VALIDATION_ERROR");
    if (!["all", "plan", "hotels", "trial"].includes(audience))
      return jsonError("Invalid audience.", 422, "VALIDATION_ERROR");

    let hotelIds: string[] = [];
    if (audience === "hotels") {
      const ids = Array.isArray(body?.hotelIds)
        ? (body.hotelIds as unknown[]).filter((i): i is string => typeof i === "string")
        : [];
      if (ids.length === 0)
        return jsonError(
          "Select at least one hotel for a targeted announcement.",
          422,
          "VALIDATION_ERROR",
        );
      hotelIds = ids;
    } else if (audience === "plan") {
      const planKey = typeof body?.planKey === "string" ? body.planKey : "";
      if (!planKey)
        return jsonError(
          "planKey is required for plan-targeted announcements.",
          422,
          "VALIDATION_ERROR",
        );
      const plan = await db.plan.findUnique({ where: { key: planKey } });
      if (!plan) return jsonError("Plan not found.", 404, "NOT_FOUND");
      const hotels = await db.hotel.findMany({
        where: { planId: plan.id, status: "ACTIVE" },
        select: { id: true },
      });
      hotelIds = hotels.map((h) => h.id);
    } else if (audience === "trial") {
      const subs = await db.subscription.findMany({
        where: { status: "TRIALING" },
        select: { hotelId: true },
      });
      hotelIds = subs.map((s) => s.hotelId);
    } else {
      const hotels = await db.hotel.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
      hotelIds = hotels.map((h) => h.id);
    }

    if (hotelIds.length === 0)
      return jsonError("No matching hotels for this announcement.", 409, "NO_RECIPIENTS");

    await db.notification.createMany({
      data: hotelIds.map((hotelId) => ({
        hotelId,
        level: severity as "INFO" | "WARNING" | "CRITICAL",
        title,
        message,
        metadata: JSON.stringify({ announcement: true, audience }),
      })),
    });
    await logAudit({
      userId: guard.session.userId,
      action: AUDIT_ACTIONS.ANNOUNCEMENT_PUBLISHED,
      entityType: "announcement",
      metadata: { title, severity, audience, recipients: hotelIds.length },
      req,
    });
    return NextResponse.json({ ok: true, recipients: hotelIds.length }, { status: 201 });
  } catch (err) {
    return serverError(err, "Could not publish the announcement.");
  }
}

import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

/**
 * Phase 18 — sustainability badges (SELF-REPORTED, labelled).
 *
 * GET   /api/ai/sustainability — list active badges (AI_READ) — public menu
 *       reads these through the public catalog endpoint instead.
 * POST  /api/ai/sustainability — create {label, description?, methodRef?} (AI_MANAGE)
 * PATCH /api/ai/sustainability — toggle {id, active} (AI_MANAGE)
 *
 * Every badge is stored with source=SELF_REPORTED; the public menu renders
 * that label next to the badge. No certification claims, no invented footprints.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AI_READ");
    if (denied) return denied;

    const badges = await db.sustainabilityBadge.findMany({
      where: { hotelId: auth.user.hotelId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return Response.json({ badges });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AI_MANAGE");
    if (denied) return denied;

    const body = (await readJson(req)) ?? {};
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) : "";
    const description = typeof body.description === "string" ? body.description.trim().slice(0, 300) : null;
    const methodRef = typeof body.methodRef === "string" ? body.methodRef.trim().slice(0, 300) : null;
    if (label.length < 2) return jsonError("Badge label is required (2-80 chars).", 422, "INVALID_LABEL");

    const badge = await db.sustainabilityBadge.create({
      data: { hotelId: auth.user.hotelId, label, description, methodRef, source: "SELF_REPORTED" },
    });

    await logAudit({
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: "SUSTAINABILITY_BADGE_CREATED",
      entityType: "sustainability_badge",
      entityId: badge.id,
      metadata: { label },
    });
    return Response.json({ badge }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AI_MANAGE");
    if (denied) return denied;

    const body = (await readJson(req)) ?? {};
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return jsonError("Badge id is required.", 422, "MISSING_ID");

    const updated = await db.sustainabilityBadge.updateMany({
      where: { id, hotelId: auth.user.hotelId },
      data: { active: body.active === true },
    });
    if (updated.count === 0) return jsonError("Badge not found.", 404, "NOT_FOUND");
    return Response.json({ ok: true });
  } catch (err) {
    return serverError(err);
  }
}

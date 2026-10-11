import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH  /api/promotions/[id] — edit (bumps version; issued bills keep their
 * snapshot) or toggle active. Body: partial fields or { active: boolean }.
 * DELETE /api/promotions/[id] — archive (deactivate). Bills that reference
 * the promotion keep their frozen snapshot rows.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "PROMOTION_MANAGE");
    if (denied) return denied;

    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");

    const existing = await db.promotion.findFirst({ where: { id, hotelId: auth.user.hotelId } });
    if (!existing) return jsonError("Promotion not found.", 404, "NOT_FOUND");

    const data: Record<string, unknown> = { version: { increment: 1 } };
    if (typeof body.name === "string" && body.name.trim().length >= 3) data.name = body.name.trim();
    // AUDIT FIX (P15-PRM-1): value fields were stored with no validation —
    // negative/zero discounts and type-inconsistent edits were accepted.
    if (typeof body.percentBps === "number") {
      const bps = Math.floor(body.percentBps);
      if (!Number.isFinite(bps) || bps <= 0 || bps > 10_000) {
        return jsonError("percentBps must be between 1 and 10000 (0.01%–100%).", 422, "INVALID_PERCENT");
      }
      data.percentBps = bps;
    }
    if (typeof body.valueMinor === "number") {
      const value = Math.floor(body.valueMinor);
      if (!Number.isFinite(value) || value <= 0) {
        return jsonError("valueMinor must be a positive integer (minor units).", 422, "INVALID_VALUE");
      }
      data.valueMinor = value;
    }
    const nextType = typeof body.type === "string" && body.type ? body.type : existing.type;
    if (nextType === "PERCENT" && (data.percentBps ?? existing.percentBps) == null) {
      return jsonError("PERCENT promotions require percentBps.", 422, "MISSING_PERCENT");
    }
    if ((nextType === "FLAT" || nextType === "COMBO") && (data.valueMinor ?? existing.valueMinor) == null) {
      return jsonError(`${nextType} promotions require valueMinor.`, 422, "MISSING_VALUE");
    }
    if (typeof body.priority === "number") {
      const priority = Math.floor(body.priority);
      if (!Number.isFinite(priority) || priority < 0 || priority > 1000) {
        return jsonError("priority must be between 0 and 1000.", 422, "INVALID_PRIORITY");
      }
      data.priority = priority;
    }
    if (typeof body.stackable === "boolean") data.stackable = body.stackable;
    if (typeof body.active === "boolean") data.active = body.active;
    if (typeof body.startTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.startTime)) data.startTime = body.startTime;
    if (typeof body.endTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.endTime)) data.endTime = body.endTime;

    const promo = await db.promotion.update({ where: { id }, data });
    await logAudit({
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: "PROMOTION_UPDATED",
      entityType: "Promotion",
      entityId: id,
      metadata: { name: promo.name, version: promo.version },
      req,
    });
    return Response.json({ promotion: promo });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "PROMOTION_MANAGE");
    if (denied) return denied;

    const { id } = await ctx.params;
    const existing = await db.promotion.findFirst({ where: { id, hotelId: auth.user.hotelId } });
    if (!existing) return jsonError("Promotion not found.", 404, "NOT_FOUND");

    // Archive, never hard-delete: bills reference promotion snapshots.
    const promo = await db.promotion.update({ where: { id }, data: { active: false, version: { increment: 1 } } });
    await logAudit({
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: "PROMOTION_ARCHIVED",
      entityType: "Promotion",
      entityId: id,
      metadata: { name: promo.name },
      req,
    });
    return Response.json({ promotion: promo });
  } catch (err) {
    return serverError(err);
  }
}

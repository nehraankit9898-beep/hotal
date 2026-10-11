import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH  /api/tax-rules/[id] — deactivate or tighten the window of an
 * existing rule. Issued bills keep their frozen taxSnapshot — historical
 * tax mutation is impossible by construction (the snapshot never reads this
 * table again after issue).
 * Body: { active?: boolean, effectiveTo?: string }
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "TAX_MANAGE");
    if (denied) return denied;

    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");

    const existing = await db.taxRule.findFirst({ where: { id, hotelId: auth.user.hotelId } });
    if (!existing) return jsonError("Tax rule not found.", 404, "NOT_FOUND");

    const data: Record<string, unknown> = {};
    if (typeof body.active === "boolean") data.active = body.active;
    if (typeof body.effectiveTo === "string") {
      const to = new Date(body.effectiveTo);
      if (Number.isNaN(to.getTime())) return jsonError("effectiveTo must be an ISO date.", 422, "INVALID_DATE");
      data.effectiveTo = to;
    }
    if (Object.keys(data).length === 0) {
      return jsonError("Nothing to update (allowed: active, effectiveTo).", 422, "EMPTY_UPDATE");
    }

    const rule = await db.taxRule.update({ where: { id }, data });
    await logAudit({
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: "TAX_RULE_UPDATED",
      entityType: "TaxRule",
      entityId: id,
      metadata: { before: { active: existing.active, effectiveTo: existing.effectiveTo }, after: data },
      req,
    });
    return Response.json({ taxRule: rule });
  } catch (err) {
    return serverError(err);
  }
}

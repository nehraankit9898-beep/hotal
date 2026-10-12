/**
 * Phase 17 — Assign a custom role to a user.
 * POST /api/custom-roles/[id]/assign { userId } — bumps target tokenVersion.
 */
import { requireAuth, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { assignCustomRole } from "@/lib/custom-roles";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOM_ROLE_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    const userId = typeof body.userId === "string" ? body.userId : "";
    if (!userId) return jsonError("userId is required.", 422, "VALIDATION_ERROR");
    const result = await assignCustomRole(auth.user, id, userId);
    if (!result.ok) return jsonError(result.error, result.status ?? 400, "CUSTOM_ROLE_ERROR");
    return jsonOk({ ok: true });
  } catch (e) {
    return serverError(e);
  }
}

/** Revoke an assignment (and all of the target user's current sessions). */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOM_ROLE_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;
    const body = await readJson(req);
    const userId = body && typeof body.userId === "string" ? body.userId : "";
    if (!userId) return jsonError("userId is required.", 422, "VALIDATION_ERROR");
    const role = await db.customRole.findFirst({
      where: { id, hotelId: auth.user.hotelId, isSystemRole: false }, select: { id: true },
    });
    const target = await db.user.findFirst({
      where: { id: userId, hotelId: auth.user.hotelId }, select: { id: true },
    });
    if (!role || !target) return jsonError("Assignment not found.", 404, "NOT_FOUND");
    const count = await db.$transaction(async (tx) => {
      const deleted = await tx.customRoleAssignment.deleteMany({
        where: { customRoleId: id, userId, customRole: { hotelId: auth.user.hotelId } },
      });
      if (deleted.count) {
        await tx.user.updateMany({
          where: { id: userId, hotelId: auth.user.hotelId },
          data: { tokenVersion: { increment: 1 } },
        });
      }
      return deleted.count;
    });
    if (!count) return jsonError("Assignment not found.", 404, "NOT_FOUND");
    await logAudit({ hotelId: auth.user.hotelId, userId: auth.user.userId,
      action: "CUSTOM_ROLE_UNASSIGNED", entityType: "User", entityId: userId,
      metadata: { customRoleId: id } });
    return jsonOk({ ok: true });
  } catch (e) { return serverError(e); }
}

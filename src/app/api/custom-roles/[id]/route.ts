import { requireAuth, jsonError, jsonOk, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { validateCustomRolePermissions, resolveUserPermissions } from "@/lib/custom-roles";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";

type Ctx = { params: Promise<{ id: string }> };

/** Edit/deactivate a tenant-defined role. Changes are read from the DB on the
 * next request; bump assignment sessions as an additional revocation fence. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOM_ROLE_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    if (body.permissions === undefined && body.active === undefined) {
      return jsonError("Provide permissions or active.", 422, "VALIDATION_ERROR");
    }
    if (body.active !== undefined && typeof body.active !== "boolean") {
      return jsonError("active must be a boolean.", 422, "VALIDATION_ERROR");
    }
    let permissions: string | undefined;
    if (body.permissions !== undefined) {
      if (!Array.isArray(body.permissions) || body.permissions.length > PERMISSIONS.length ||
          body.permissions.some((p) => typeof p !== "string")) {
        return jsonError("permissions must be an array of permission names.", 422, "VALIDATION_ERROR");
      }
      const checked = validateCustomRolePermissions(
        body.permissions, auth.user.role, await resolveUserPermissions(auth.user),
      );
      if (!checked.ok) return jsonError(checked.error, 422, "VALIDATION_ERROR");
      permissions = JSON.stringify(checked.permissions);
    }
    const role = await db.customRole.findFirst({
      where: { id, hotelId: auth.user.hotelId, isSystemRole: false }, select: { id: true },
    });
    if (!role) return jsonError("Custom role not found.", 404, "NOT_FOUND");
    await db.$transaction(async (tx) => {
      const updated = await tx.customRole.updateMany({
        where: { id, hotelId: auth.user.hotelId, isSystemRole: false },
        data: { ...(permissions !== undefined ? { permissions } : {}),
          ...(body.active !== undefined ? { active: body.active as boolean } : {}) },
      });
      if (updated.count !== 1) throw new Error("Custom role changed concurrently.");
      const assignments = await tx.customRoleAssignment.findMany({
        where: { customRoleId: id }, select: { userId: true },
      });
      if (assignments.length) {
        await tx.user.updateMany({
          where: { id: { in: assignments.map((a) => a.userId) }, hotelId: auth.user.hotelId },
          data: { tokenVersion: { increment: 1 } },
        });
      }
    });
    await logAudit({ hotelId: auth.user.hotelId, userId: auth.user.userId,
      action: "CUSTOM_ROLE_UPDATED", entityType: "CustomRole", entityId: id,
      metadata: { active: body.active, permissionsChanged: permissions !== undefined } });
    return jsonOk({ ok: true });
  } catch (e) { return serverError(e); }
}

import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/api-keys/[id] — revoke a key. Revocation is permanent (the hash
 * stays for audit, the key can never authenticate again). Tenant-scoped.
 */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "SETTINGS_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;

    const key = await db.apiKey.findFirst({
      where: { id, hotelId: auth.user.hotelId },
    });
    if (!key) return jsonError("API key not found.", 404, "NOT_FOUND");
    if (key.status === "REVOKED") {
      return jsonError("This API key is already revoked.", 409, "ALREADY_REVOKED");
    }

    await db.apiKey.update({
      where: { id },
      data: { status: "REVOKED", revokedAt: new Date() },
    });

    await logAudit({
      req,
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: AUDIT_ACTIONS.API_KEY_REVOKED,
      entityType: "api_key",
      entityId: id,
      metadata: { name: key.name, prefix: key.prefix },
    });

    return Response.json({ revoked: true, id });
  } catch (err) {
    return serverError(err, "Could not revoke the API key. Please try again.");
  }
}

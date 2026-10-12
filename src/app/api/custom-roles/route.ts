/**
 * Phase 17 — Custom roles API.
 * GET  /api/custom-roles          → list roles for the caller's hotel
 * POST /api/custom-roles          → create a new role (with granted permissions)
 */
import { requireAuth, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { createCustomRole } from "@/lib/custom-roles";
import { db } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOM_ROLE_MANAGE");
    if (denied) return denied;
    const roles = await db.customRole.findMany({
      where: { hotelId: auth.user.hotelId },
      select: {
        id: true,
        name: true,
        description: true,
        permissions: true,
        active: true,
        isSystemRole: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return jsonOk({ roles, permissionCatalog: PERMISSIONS });
  } catch (e) {
    return serverError(e);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOM_ROLE_MANAGE");
    if (denied) return denied;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return jsonError("Role name is required.", 422, "VALIDATION_ERROR");
    if (!Array.isArray(body.permissions) || body.permissions.length > PERMISSIONS.length ||
        body.permissions.some((p) => typeof p !== "string")) {
      return jsonError("permissions must be an array of permission names.", 422, "VALIDATION_ERROR");
    }
    const description = typeof body.description === "string" ? body.description : undefined;
    const result = await createCustomRole(auth.user, name, body.permissions, description);
    if (!result.ok) return jsonError(result.error, result.status ?? 400, "CUSTOM_ROLE_ERROR");
    return jsonOk({ id: result.id }, 201);
  } catch (e) {
    return serverError(e);
  }
}

/**
 * Phase 17 — Custom roles API.
 * GET  /api/custom-roles          → list roles for the caller's hotel
 * POST /api/custom-roles          → create a new role (with granted permissions)
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { createCustomRole, validateCustomRolePermissions } from "@/lib/custom-roles";
import { db } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    if (auth.user.role === "SUPER_ADMIN") {
      return jsonError("Custom roles are tenant-only.", 403, "FORBIDDEN");
    }
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
    const permissionsRaw = Array.isArray(body.permissions) ? body.permissions : [];
    // Fast-fail validation before DB calls.
    const fast = validateCustomRolePermissions(
      permissionsRaw.filter((p): p is string => typeof p === "string"),
      auth.user.role,
      // Owner is the caller — for HOTEL_OWNER/HOTEL_ADMIN this is "all"
      // (already includes everything except SUPER_ADMIN_ACCESS, which the
      // validator rejects). For other callers with CUSTOM_ROLE_MANAGE
      // (rare), the validator will check.
      PERMISSIONS as unknown as Parameters<typeof validateCustomRolePermissions>[2],
    );
    if (!fast.ok) return jsonError(fast.error, 422, "VALIDATION_ERROR");
    const description = typeof body.description === "string" ? body.description : undefined;
    const result = await createCustomRole(auth.user, name, fast.permissions, description);
    if (!result.ok) return jsonError(result.error, result.status ?? 400, "CUSTOM_ROLE_ERROR");
    return jsonOk({ id: result.id }, 201);
  } catch (e) {
    return serverError(e);
  }
}

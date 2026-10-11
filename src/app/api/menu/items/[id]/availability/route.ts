import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { validateOptionGroups } from "@/lib/menu";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/menu/items/[id]/availability — { available: boolean }
 *
 * The KITCHEN-scoped toggle. Held by KITCHEN_STAFF (who cannot edit prices or
 * configuration) and by MENU_MANAGE roles. This is deliberately a separate
 * route from the item PATCH so the permission split is enforced server-side:
 * kitchen availability ≠ catalog configuration.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;

    // Either the kitchen-scoped availability permission or full menu manage.
    const canManage = requirePermission(auth.user, "MENU_MANAGE") === null;
    const canToggle = requirePermission(auth.user, "MENU_AVAILABILITY") === null;
    if (!canManage && !canToggle) {
      return jsonError("You do not have permission to change item availability.", 403, "FORBIDDEN");
    }

    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body || typeof body.available !== "boolean") {
      return jsonError("Send { available: true|false }.");
    }

    const res = await db.menuItem.updateMany({
      where: { id, hotelId: auth.user.hotelId, active: true },
      data: { available: body.available },
    });
    if (res.count !== 1) return jsonError("Menu item not found.", 404, "NOT_FOUND");
    return Response.json({ ok: true, available: body.available });
  } catch (err) {
    return serverError(err, "Availability could not be updated.");
  }
}

// keep tree-shaking honest: option groups validation is used by the options route
void validateOptionGroups;

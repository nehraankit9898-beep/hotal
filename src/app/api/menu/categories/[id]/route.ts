import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH   /api/menu/categories/[id] — rename/reorder (MENU_MANAGE)
 * DELETE  /api/menu/categories/[id] — archive (items inside are archived too)
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "MENU_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;

    const existing = await db.menuCategory.findFirst({
      where: { id, hotelId: auth.user.hotelId },
      select: { id: true },
    });
    if (!existing) return jsonError("Category not found.", 404, "NOT_FOUND");

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const data: { name?: string; description?: string | null; sortOrder?: number } = {};
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (name.length < 2 || name.length > 80) {
        return jsonError("Category name must be 2-80 characters.");
      }
      // AUDIT FIX (P12-CAT-1): renames must not collide with another ACTIVE
      // category of the same tenant (mirrors the POST guard).
      const dupe = await db.menuCategory.findFirst({
        where: { hotelId: auth.user.hotelId, active: true, name, id: { not: id } },
        select: { id: true },
      });
      if (dupe) return jsonError(`Category "${name}" already exists.`, 409, "DUPLICATE");
      data.name = name;
    }
    if (typeof body.description === "string") data.description = body.description.slice(0, 500);
    if (Number.isInteger(Number(body.sortOrder))) data.sortOrder = Number(body.sortOrder);

    const category = await db.menuCategory.update({ where: { id }, data });
    return Response.json({ category });
  } catch (err) {
    return serverError(err, "The category could not be updated.");
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "MENU_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;

    // Archive the category AND its items in one transaction (an empty-looking
    // category with live items would corrupt the public menu ordering).
    const result = await db.$transaction(async (tx) => {
      const cat = await tx.menuCategory.findFirst({
        where: { id, hotelId: auth.user.hotelId },
        select: { id: true },
      });
      if (!cat) return null;
      await tx.menuItem.updateMany({
        where: { categoryId: id, hotelId: auth.user.hotelId },
        data: { active: false, available: false },
      });
      await tx.menuCategory.update({ where: { id }, data: { active: false } });
      return cat;
    });
    if (!result) return jsonError("Category not found.", 404, "NOT_FOUND");
    return Response.json({ ok: true, archived: true });
  } catch (err) {
    return serverError(err, "The category could not be archived.");
  }
}

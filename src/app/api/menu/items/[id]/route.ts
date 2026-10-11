import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { validateMenuItem } from "@/lib/menu";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET   /api/menu/items/[id] — item detail (tenant-scoped)
 * PATCH /api/menu/items/[id] — edit config (price/name/options…): MENU_MANAGE.
 *        The `available` flag is IGNORED here by design — flipping availability
 *        is a separate kitchen-scoped route (MENU_AVAILABILITY) so a waiter or
 *        manager editing the catalog can never accidentally un-sell-out an
 *        item the kitchen marked sold out.
 * DELETE /api/menu/items/[id] — ARCHIVE (soft). Archived items keep their
 *        order-history snapshots (OrderItem.menuItemId is SetNull).
 */

export async function GET(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "MENU_READ");
    if (denied) return denied;
    const { id } = await ctx.params;

    const item = await db.menuItem.findFirst({
      where: { id, hotelId: auth.user.hotelId },
      include: {
        optionGroups: {
          orderBy: { sortOrder: "asc" },
          include: { options: { orderBy: { sortOrder: "asc" } } },
        },
      },
    });
    if (!item) return jsonError("Menu item not found.", 404, "NOT_FOUND");
    return Response.json({ item });
  } catch (err) {
    return serverError(err, "Menu item could not be loaded.");
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "MENU_MANAGE");
    if (denied) return denied;
    const hotelId = auth.user.hotelId;
    const { id } = await ctx.params;

    const existing = await db.menuItem.findFirst({
      where: { id, hotelId },
      select: { id: true },
    });
    if (!existing) return jsonError("Menu item not found.", 404, "NOT_FOUND");

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    // BUG-7: an explicit null / non-numeric price is a CLIENT BUG (the UI
    // computed NaN from bad input and JSON.stringify turned it into null).
    // Reject it loudly instead of silently keeping the old price while the
    // client toasts "Item updated".
    if (
      "priceMinor" in body &&
      (body.priceMinor === null || body.priceMinor === "" || !Number.isFinite(Number(body.priceMinor)))
    ) {
      return jsonError("Price must be a valid integer amount in paise.", 400, "VALIDATION_ERROR");
    }

    // D15: distinguish OMITTED properties from EXPLICIT NULL — PATCHing
    // { imageUrl: null, description: null } must CLEAR both fields (the old
    // `body.x ?? current.x` merge treated clearing as absence and kept the
    // old values forever).
    const clearDescription = "description" in body && body.description === null;
    const clearImageUrl = "imageUrl" in body && body.imageUrl === null;

    // Allow partial edits: merge with the current row for validation.
    const current = await db.menuItem.findUnique({ where: { id } });
    if (!current) return jsonError("Menu item not found.", 404, "NOT_FOUND");

    const merged = {
      name: body.name ?? current.name,
      description: clearDescription ? "" : body.description ?? current.description ?? "",
      priceMinor: body.priceMinor ?? current.priceMinor,
      prepMinutes: body.prepMinutes ?? current.prepMinutes,
      imageUrl: clearImageUrl ? "" : body.imageUrl ?? current.imageUrl ?? "",
      dietaryTags: body.dietaryTags ?? JSON.parse(current.dietaryTags ?? "[]"),
      sortOrder: body.sortOrder ?? current.sortOrder,
      active: body.active ?? current.active,
    };
    const { issues, value } = validateMenuItem(merged);
    if (!value) {
      return jsonError(issues[0]?.message ?? "Invalid menu item.", 400, "VALIDATION_ERROR");
    }

    // Category move (optional) — must stay inside the tenant.
    let categoryId = current.categoryId;
    if (typeof body.categoryId === "string" && body.categoryId !== current.categoryId) {
      const category = await db.menuCategory.findFirst({
        where: { id: body.categoryId, hotelId },
        select: { id: true },
      });
      if (!category) return jsonError("Menu category not found.", 404, "NOT_FOUND");
      categoryId = category.id;
    }

    const item = await db.menuItem.update({
      where: { id },
      data: {
        categoryId,
        name: value.name,
        // D15: explicit null clears the field; an omitted key keeps the old value.
        description: clearDescription ? null : value.description,
        priceMinor: value.priceMinor,
        dietaryTags: JSON.stringify(value.dietaryTags),
        imageUrl: clearImageUrl ? null : value.imageUrl,
        prepMinutes: value.prepMinutes,
        sortOrder: value.sortOrder,
        active: value.active,
      },
    });
    return Response.json({ item });
  } catch (err) {
    return serverError(err, "The menu item could not be updated.");
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "MENU_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;

    // ARCHIVE, not hard delete — transaction history keeps referencing the id.
    const res = await db.menuItem.updateMany({
      where: { id, hotelId: auth.user.hotelId },
      data: { active: false, available: false },
    });
    if (res.count !== 1) return jsonError("Menu item not found.", 404, "NOT_FOUND");
    return Response.json({ ok: true, archived: true });
  } catch (err) {
    return serverError(err, "The menu item could not be archived.");
  }
}

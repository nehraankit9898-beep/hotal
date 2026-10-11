import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { withHotelWriteLock } from "@/lib/saas/limits";

/**
 * Phase 12 — menu categories.
 * GET  /api/menu/categories — list (with item counts)
 * POST /api/menu/categories — create { name, description?, sortOrder? }
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "MENU_READ");
    if (denied) return denied;

    const categories = await db.menuCategory.findMany({
      where: { hotelId: auth.user.hotelId, active: true },
      orderBy: { sortOrder: "asc" },
      include: { _count: { select: { items: { where: { active: true } } } } },
    });

    return Response.json({
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        sortOrder: c.sortOrder,
        itemCount: c._count.items,
      })),
    });
  } catch (err) {
    return serverError(err, "Menu categories could not be loaded.");
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "MENU_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 2 || name.length > 80) {
      return jsonError("Category name must be 2-80 characters.");
    }

    // Category count cap (50) — ATOMICALLY (BUG-7/D17): count + create inside
    // the per-hotel write-locked transaction so concurrent creates cannot
    // both pass the check.
    // AUDIT FIX (P12-CAT-1): duplicate ACTIVE names are rejected inside the
    // same lock — unbounded identical categories previously all rendered on
    // the public menu (spec: "duplicate category handled").
    const category = await withHotelWriteLock(auth.user.hotelId, async (tx) => {
      const count = await tx.menuCategory.count({
        where: { hotelId: auth.user.hotelId, active: true },
      });
      if (count >= 50) return null;
      const dupe = await tx.menuCategory.findFirst({
        where: { hotelId: auth.user.hotelId, active: true, name: { equals: name } },
        select: { id: true },
      });
      if (dupe) return "DUPLICATE" as const;
      return tx.menuCategory.create({
        data: {
          hotelId: auth.user.hotelId,
          name,
          description:
            typeof body.description === "string" && body.description.trim()
              ? body.description.trim().slice(0, 500)
              : null,
          sortOrder: Number.isInteger(Number(body.sortOrder)) ? Number(body.sortOrder) : count,
        },
      });
    });
    if (category === "DUPLICATE") {
      return jsonError(`Category "${name}" already exists.`, 409, "DUPLICATE");
    }
    if (!category) {
      return jsonError("You can have up to 50 active categories.", 403, "PLAN_LIMIT");
    }
    return Response.json({ category }, { status: 201 });
  } catch (err) {
    return serverError(err, "The category could not be created.");
  }
}

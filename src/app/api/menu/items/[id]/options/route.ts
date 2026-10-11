import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { validateOptionGroups } from "@/lib/menu";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/menu/items/[id]/options — current option groups + options
 * PUT /api/menu/items/[id]/options — REPLACE-ALL groups/options (edit UI).
 *
 * Replace-all is used instead of per-option PATCHes because option groups are
 * small, always edited as a whole in the owner UI, and a single transaction
 * keeps the catalog consistent (no half-edited group). Historical order
 * snapshots are unaffected — OrderItem stores its own options snapshot.
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
      select: { id: true },
    });
    if (!item) return jsonError("Menu item not found.", 404, "NOT_FOUND");

    const groups = await db.menuOptionGroup.findMany({
      where: { menuItemId: id, active: true },
      orderBy: { sortOrder: "asc" },
      include: { options: { where: { active: true }, orderBy: { sortOrder: "asc" } } },
    });
    return Response.json({ groups });
  } catch (err) {
    return serverError(err, "Options could not be loaded.");
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "MENU_MANAGE");
    if (denied) return denied;
    const hotelId = auth.user.hotelId;
    const { id } = await ctx.params;

    const item = await db.menuItem.findFirst({
      where: { id, hotelId },
      select: { id: true },
    });
    if (!item) return jsonError("Menu item not found.", 404, "NOT_FOUND");

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const { issues, value } = validateOptionGroups(body.groups);
    if (!value) {
      return jsonError(
        issues[0]?.message ?? "Invalid option groups.",
        400,
        "VALIDATION_ERROR",
      );
    }

    // Replace-all in ONE transaction (D18): deactivate old groups, create the
    // new groups AND their options with NESTED creates inside the SAME
    // transaction. The old code created options AFTER the transaction — a
    // failure left active groups with ZERO options and the old configuration
    // already deactivated (catalog corruption). Order snapshots are unaffected
    // — OrderItem stores its own options snapshot.
    const groups = await db.$transaction(async (tx) => {
      await tx.menuOptionGroup.updateMany({
        where: { menuItemId: id, hotelId },
        data: { active: false },
      });
      const created: { id: string }[] = [];
      for (let gi = 0; gi < value.length; gi++) {
        const g = value[gi];
        const group = await tx.menuOptionGroup.create({
          data: {
            hotelId,
            menuItemId: id,
            name: g.name,
            required: g.required ?? false,
            minSelect: g.minSelect ?? 0,
            maxSelect: g.maxSelect ?? 1,
            sortOrder: g.sortOrder ?? gi,
            // D14: persist the validated active state (was hardcoded true).
            active: g.active ?? true,
            options: {
              create: g.options.map((o, oi) => ({
                hotelId,
                name: o.name,
                priceDeltaMinor: o.priceDeltaMinor ?? 0,
                sortOrder: o.sortOrder ?? oi,
                // D14: persist the validated active state (was hardcoded true).
                active: o.active ?? true,
              })),
            },
          },
          select: { id: true },
        });
        created.push(group);
      }
      return created;
    });
    void groups;

    const fresh = await db.menuOptionGroup.findMany({
      where: { menuItemId: id, active: true },
      orderBy: { sortOrder: "asc" },
      include: { options: { where: { active: true }, orderBy: { sortOrder: "asc" } } },
    });
    return Response.json({ groups: fresh });
  } catch (err) {
    return serverError(err, "Options could not be saved.");
  }
}

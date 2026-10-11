import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { validateMenuItem, validateOptionGroups, menuItemCapFor } from "@/lib/menu";
import { withHotelWriteLock } from "@/lib/saas/limits";

/**
 * Phase 12 — menu items API.
 *
 * GET  /api/menu/items?categoryId=&includeArchived=1 — list items
 * POST /api/menu/items — create an item (option groups inline, single txn)
 *
 * Tenant-scoped: every query filters by hotelId; cross-tenant ids are
 * indistinguishable from missing ones (404).
 */

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "MENU_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const categoryId = url.searchParams.get("categoryId");
    const includeArchived = url.searchParams.get("includeArchived") === "1";

    const items = await db.menuItem.findMany({
      where: {
        hotelId: auth.user.hotelId,
        ...(categoryId ? { categoryId } : {}),
        ...(includeArchived ? {} : { active: true }),
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        categoryId: true,
        name: true,
        description: true,
        priceMinor: true,
        currency: true,
        dietaryTags: true,
        imageUrl: true,
        active: true,
        available: true,
        prepMinutes: true,
        sortOrder: true,
        createdAt: true,
        updatedAt: true,
        optionGroups: {
          where: { active: true },
          orderBy: { sortOrder: "asc" },
          select: {
            id: true,
            name: true,
            required: true,
            minSelect: true,
            maxSelect: true,
            sortOrder: true,
            options: {
              where: { active: true },
              orderBy: { sortOrder: "asc" },
              select: { id: true, name: true, priceDeltaMinor: true, sortOrder: true },
            },
          },
        },
      },
    });

    return Response.json({ items });
  } catch (err) {
    return serverError(err, "Menu items could not be loaded.");
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "MENU_MANAGE");
    if (denied) return denied;
    const hotelId = auth.user.hotelId;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    // Category must belong to this tenant.
    const categoryId = typeof body.categoryId === "string" ? body.categoryId : "";
    const category = await db.menuCategory.findFirst({
      where: { id: categoryId, hotelId },
      select: { id: true },
    });
    if (!category) return jsonError("Menu category not found.", 404, "NOT_FOUND");

    const { issues, value } = validateMenuItem(body);
    if (!value) {
      return jsonError(issues[0]?.message ?? "Invalid menu item.", 400, "VALIDATION_ERROR");
    }

    const groupsResult = validateOptionGroups(body.optionGroups);
    if (!groupsResult.value) {
      return jsonError(
        groupsResult.issues[0]?.message ?? "Invalid option groups.",
        400,
        "VALIDATION_ERROR",
      );
    }

    // Plan-aware catalog cap — ATOMICALLY enforced (BUG-7/D17): the count
    // AND the create run inside one per-hotel write-locked transaction, so
    // two concurrent creates cannot both slip past the check. Only ACTIVE
    // items count (the error message tells users to archive to free space —
    // archived items counting toward the cap made that advice a lie).
    const cap = await menuItemCapFor(hotelId);
    const groups = groupsResult.value ?? [];

    const created = await withHotelWriteLock(hotelId, async (tx) => {
      const existing = await tx.menuItem.count({ where: { hotelId, active: true } });
      if (existing >= cap) return null;
      return tx.menuItem.create({
        data: {
          hotelId,
          categoryId: category.id,
          name: value.name,
          description: value.description,
          priceMinor: value.priceMinor,
          currency: "INR",
          dietaryTags: JSON.stringify(value.dietaryTags),
          imageUrl: value.imageUrl,
          active: value.active,
          available: value.available,
          prepMinutes: value.prepMinutes,
          sortOrder: value.sortOrder,
          optionGroups:
            groups.length > 0
              ? {
                  create: groups.map((g, gi) => ({
                    hotelId,
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
                        // D14: persist the validated active state.
                        active: o.active ?? true,
                      })),
                    },
                  })),
                }
              : undefined,
        },
        include: { optionGroups: { include: { options: true } } },
      });
    });

    if (!created) {
      return jsonError(
        `Your plan allows up to ${cap} menu items. Archive unused items or upgrade your plan.`,
        403,
        "PLAN_LIMIT",
      );
    }

    return Response.json({ item: created }, { status: 201 });
  } catch (err) {
    return serverError(err, "The menu item could not be created.");
  }
}

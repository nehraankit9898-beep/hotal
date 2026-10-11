import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { recipeCostEstimate } from "@/lib/inventory";

/**
 * Phase 16 — recipes (menu item → ingredient quantities).
 * GET  /api/inventory/recipes?menuItemId= — lines (+ optional cost estimate)
 * POST /api/inventory/recipes — { menuItemId, ingredientId, qtyPerUnit }
 * DELETE /api/inventory/recipes?id= — remove a line
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "INVENTORY_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const menuItemId = url.searchParams.get("menuItemId");
    const lines = await db.recipeLine.findMany({
      where: { hotelId: auth.user.hotelId, ...(menuItemId ? { menuItemId } : {}) },
      orderBy: { menuItemId: "asc" },
      include: { ingredient: { select: { name: true, unit: true, costPerUnitMinor: true } } },
    });
    const estimate = menuItemId ? await recipeCostEstimate(auth.user.hotelId!, menuItemId) : null;
    return Response.json({ lines, estimate });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "INVENTORY_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");
    const menuItemId = typeof body.menuItemId === "string" ? body.menuItemId : "";
    const ingredientId = typeof body.ingredientId === "string" ? body.ingredientId : "";
    const qtyPerUnit = Number(body.qtyPerUnit);
    if (!menuItemId || !ingredientId) return jsonError("menuItemId and ingredientId are required.", 422, "MISSING_FIELD");
    if (!Number.isFinite(qtyPerUnit) || qtyPerUnit <= 0) {
      return jsonError("qtyPerUnit must be a positive number (ingredient base units per item).", 422, "INVALID_QTY");
    }
    const item = await db.menuItem.findFirst({ where: { id: menuItemId, hotelId: auth.user.hotelId } });
    if (!item) return jsonError("Menu item not found.", 404, "NOT_FOUND");
    const ingredient = await db.ingredient.findFirst({ where: { id: ingredientId, hotelId: auth.user.hotelId } });
    if (!ingredient) return jsonError("Ingredient not found.", 404, "NOT_FOUND");

    const line = await db.recipeLine.create({
      data: { hotelId: auth.user.hotelId!, menuItemId, ingredientId, qtyPerUnit },
      include: { ingredient: { select: { name: true, unit: true } } },
    }).catch(() => null);
    if (!line) return jsonError("This recipe line already exists.", 422, "DUPLICATE_LINE");
    return Response.json({ line }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "INVENTORY_MANAGE");
    if (denied) return denied;

    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return jsonError("id is required.", 422, "MISSING_FIELD");
    const existing = await db.recipeLine.findFirst({ where: { id, hotelId: auth.user.hotelId } });
    if (!existing) return jsonError("Recipe line not found.", 404, "NOT_FOUND");
    await db.recipeLine.delete({ where: { id } });
    return Response.json({ deleted: true });
  } catch (err) {
    return serverError(err);
  }
}

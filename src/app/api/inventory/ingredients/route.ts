import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { INGREDIENT_UNITS, recordMovement } from "@/lib/inventory";
import { logAudit } from "@/lib/audit";

/**
 * Phase 16 — inventory ingredients.
 * GET  /api/inventory/ingredients?lowStock=1 — list (+ low-stock filter)
 * POST /api/inventory/ingredients — create { name, unit, openingQty?,
 *   costPerUnitMinor?, lowStockThreshold? } (opening stock → ledger OPENING)
 * PATCH /api/inventory/ingredients — { id, name?, lowStockThreshold?,
 *   active? } — config edits only; STOCK changes go through /ledger.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "INVENTORY_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const lowOnly = url.searchParams.get("lowStock") === "1";
    const ingredients = await db.ingredient.findMany({
      where: { hotelId: auth.user.hotelId },
      orderBy: { name: "asc" },
    });
    return Response.json({
      ingredients: lowOnly
        ? ingredients.filter((i) => i.stockQty <= i.lowStockThreshold)
        : ingredients,
    });
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
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 2) return jsonError("Ingredient name is required.", 422, "INVALID_NAME");
    const unit = body.unit;
    if (typeof unit !== "string" || !INGREDIENT_UNITS.includes(unit as never)) {
      return jsonError(`unit must be one of ${INGREDIENT_UNITS.join(", ")}.`, 422, "INVALID_UNIT");
    }
    const costPerUnitMinor = Number.isFinite(Number(body.costPerUnitMinor)) ? Math.max(0, Math.floor(Number(body.costPerUnitMinor))) : 0;
    const lowStockThreshold = Number.isFinite(Number(body.lowStockThreshold)) ? Math.max(0, Number(body.lowStockThreshold)) : 0;
    const openingQty = Number.isFinite(Number(body.openingQty)) ? Math.max(0, Number(body.openingQty)) : 0;

    const ingredient = await db.ingredient.create({
      data: { hotelId: auth.user.hotelId!, name, unit, costPerUnitMinor, lowStockThreshold, stockQty: 0 },
    });
    if (openingQty > 0) {
      await recordMovement({
        hotelId: auth.user.hotelId!,
        ingredientId: ingredient.id,
        reason: "OPENING",
        qtyDelta: openingQty,
        unitCostMinor: costPerUnitMinor,
        note: "Opening stock",
        createdByUserId: auth.user.userId,
      });
    }
    await logAudit({
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: "INGREDIENT_CREATED",
      entityType: "Ingredient",
      entityId: ingredient.id,
      metadata: { name, unit, openingQty },
      req,
    });
    const fresh = await db.ingredient.findUnique({ where: { id: ingredient.id } });
    return Response.json({ ingredient: fresh }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "INVENTORY_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body || typeof body.id !== "string") return jsonError("Expected { id, ... }.", 400, "BAD_REQUEST");
    const data: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim().length >= 2) data.name = body.name.trim();
    if (Number.isFinite(Number(body.lowStockThreshold))) data.lowStockThreshold = Math.max(0, Number(body.lowStockThreshold));
    if (typeof body.active === "boolean") data.active = body.active;
    if (Object.keys(data).length === 0) return jsonError("Nothing to update.", 422, "EMPTY_UPDATE");

    const existing = await db.ingredient.findFirst({ where: { id: body.id, hotelId: auth.user.hotelId } });
    if (!existing) return jsonError("Ingredient not found.", 404, "NOT_FOUND");
    const ingredient = await db.ingredient.update({ where: { id: existing.id }, data });
    return Response.json({ ingredient });
  } catch (err) {
    return serverError(err);
  }
}

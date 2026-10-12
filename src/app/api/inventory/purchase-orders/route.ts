import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";

/**
 * Phase 16 — suppliers & purchase orders.
 * GET  /api/inventory/purchase-orders?status= — PO list
 * POST /api/inventory/purchase-orders — create PO
 *   { supplierId | supplier: {name, phone?}, lines: [{ingredientId, qty, unitCostMinor}], expectedAt?, notes? }
 * PATCH /api/inventory/purchase-orders — { id, action: "SUBMIT"|"CANCEL" }
 * Goods receipt: POST { id, action: "RECEIVE" } → stock ledger PURCHASE rows
 * (one per line, exactly-once via ledger fence refType=PURCHASE_ORDER).
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "INVENTORY_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const orders = await db.purchaseOrder.findMany({
      where: { hotelId: auth.user.hotelId, ...(status ? { status: status as never } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        supplier: { select: { name: true, phone: true } },
        lines: { include: { ingredient: { select: { name: true, unit: true } } } },
      },
    });
    const suppliers = await db.supplier.findMany({ where: { hotelId: auth.user.hotelId, active: true } });
    return Response.json({ orders, suppliers });
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

    // Supplier: existing id or inline create.
    let supplierId = typeof body.supplierId === "string" ? body.supplierId : "";
    if (!supplierId && body.supplier && typeof body.supplier === "object") {
      const s = body.supplier as Record<string, unknown>;
      const name = typeof s.name === "string" ? s.name.trim() : "";
      if (name.length < 2) return jsonError("Supplier name is required.", 422, "INVALID_SUPPLIER");
      const supplier = await db.supplier.create({
        data: {
          hotelId: auth.user.hotelId!,
          name,
          phone: typeof s.phone === "string" ? s.phone.slice(0, 20) : null,
          email: typeof s.email === "string" ? s.email.slice(0, 120) : null,
        },
      });
      supplierId = supplier.id;
    }
    if (!supplierId) return jsonError("supplierId or supplier is required.", 422, "MISSING_SUPPLIER");
    const supplier = await db.supplier.findFirst({ where: { id: supplierId, hotelId: auth.user.hotelId } });
    if (!supplier) return jsonError("Supplier not found.", 404, "NOT_FOUND");

    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      return jsonError("At least one PO line is required.", 422, "EMPTY_LINES");
    }
    const linesIn = (body.lines as unknown[]).slice(0, 50);
    const parsed: Array<{ ingredientId: string; qty: number; unitCostMinor: number; lineTotalMinor: number }> = [];
    for (const raw of linesIn) {
      const l = raw as Record<string, unknown>;
      const ingredientId = typeof l.ingredientId === "string" ? l.ingredientId : "";
      const qty = Number(l.qty);
      const unitCostMinor = Number(l.unitCostMinor);
      if (!ingredientId || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitCostMinor) || unitCostMinor < 0) {
        return jsonError("Each line needs ingredientId, positive qty and unitCostMinor.", 422, "INVALID_LINE");
      }
      const ing = await db.ingredient.findFirst({ where: { id: ingredientId, hotelId: auth.user.hotelId } });
      if (!ing) return jsonError(`Ingredient ${ingredientId} not found.`, 404, "NOT_FOUND");
      parsed.push({ ingredientId, qty, unitCostMinor, lineTotalMinor: Math.round(qty * unitCostMinor) });
    }
    const totalMinor = parsed.reduce((s, l) => s + l.lineTotalMinor, 0);

    const poNumber = (await db.purchaseOrder.count({ where: { hotelId: auth.user.hotelId } })) + 1;
    const po = await db.purchaseOrder.create({
      data: {
        hotelId: auth.user.hotelId!,
        supplierId,
        status: "DRAFT",
        poNumber,
        totalMinor,
        expectedAt: typeof body.expectedAt === "string" ? new Date(body.expectedAt) : null,
        notes: typeof body.notes === "string" ? body.notes.slice(0, 500) : null,
        createdByUserId: auth.user.userId,
        lines: { create: parsed },
      },
      include: { lines: true },
    });
    return Response.json({ order: po }, { status: 201 });
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
    if (!body || typeof body.id !== "string" || typeof body.action !== "string") {
      return jsonError("Expected { id, action }.", 422, "INVALID_ACTION");
    }
    const po = await db.purchaseOrder.findFirst({
      where: { id: body.id, hotelId: auth.user.hotelId },
      include: { lines: true },
    });
    if (!po) return jsonError("Purchase order not found.", 404, "NOT_FOUND");

    if (body.action === "SUBMIT") {
      if (po.status !== "DRAFT") return jsonError("Only DRAFT orders can be submitted.", 422, "INVALID_STATE");
      const updated = await db.purchaseOrder.update({ where: { id: po.id }, data: { status: "SUBMITTED" } });
      return Response.json({ order: updated });
    }
    if (body.action === "CANCEL") {
      if (po.status === "RECEIVED") return jsonError("Received orders cannot be cancelled.", 422, "INVALID_STATE");
      const updated = await db.purchaseOrder.update({ where: { id: po.id }, data: { status: "CANCELLED" } });
      return Response.json({ order: updated });
    }
    if (body.action === "RECEIVE") {
      if (po.status !== "SUBMITTED") return jsonError("Only SUBMITTED orders can be received.", 422, "INVALID_STATE");
      // Goods receipt → PURCHASE ledger rows (exactly-once via ledger fence).
      // One movement per ingredient: the fence is per (ingredient, PO), so
      // duplicate-ingredient lines must be merged first.
      const { recordMovement, aggregateReceiptLines } = await import("@/lib/inventory");
      for (const line of aggregateReceiptLines(po.lines)) {
        await db.$transaction(
          async (tx) => {
            const fence = await tx.stockLedger.findUnique({
              where: {
                ingredientId_refType_refId_reason: {
                  ingredientId: line.ingredientId,
                  refType: "PURCHASE_ORDER",
                  refId: po.id,
                  reason: "PURCHASE",
                },
              },
            });
            if (fence) return;
            await recordMovement({
              hotelId: auth.user.hotelId!,
              ingredientId: line.ingredientId,
              reason: "PURCHASE",
              qtyDelta: line.qty,
              unitCostMinor: line.unitCostMinor,
              refType: "PURCHASE_ORDER",
              refId: po.id,
              note: `Goods receipt PO#${po.poNumber}`,
              createdByUserId: auth.user.userId,
              tx,
            });
          },
          { timeout: 30_000 },
        );
      }
      const updated = await db.purchaseOrder.update({
        where: { id: po.id },
        data: { status: "RECEIVED", receivedAt: new Date() },
      });
      return Response.json({ order: updated });
    }
    return jsonError("action must be SUBMIT, CANCEL or RECEIVE.", 422, "INVALID_ACTION");
  } catch (err) {
    return serverError(err);
  }
}

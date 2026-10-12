/**
 * Phase 16 — inventory & recipes.
 *
 * STOCK POLICY (documented):
 *  - Consumption is deducted ONCE per PAID bill (BILL_PAID basis — explicit
 *    policy choice; the ledger unique (ingredientId, refType, refId, reason)
 *    with refType="BILL", reason="CONSUMPTION" is the fence).
 *  - Cancellation/refund does NOT blindly return consumed ingredients —
 *    recovery is an explicit WASTAGE/RETURN ledger entry by staff.
 *  - balanceAfter is maintained transactionally (atomic increment + write);
 *    SQLite serializes writes; PostgreSQL serializes on the ingredient row.
 *  - Units: GRAM | KG | ML | LITRE | PIECE. Conversions happen at entry time
 *    (purchase/recipe input), never implicitly at deduction time.
 */

import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";

export const INGREDIENT_UNITS = ["GRAM", "KG", "ML", "LITRE", "PIECE"] as const;
export type IngredientUnit = (typeof INGREDIENT_UNITS)[number];

/** Convert a quantity in `from` unit to the base unit of `to` when compatible. */
export function convertUnit(qty: number, from: string, to: string): number | null {
  if (from === to) return qty;
  const mass: Record<string, number> = { GRAM: 1, KG: 1000 };
  const vol: Record<string, number> = { ML: 1, LITRE: 1000 };
  if (mass[from] && mass[to]) return (qty * mass[from]) / mass[to];
  if (vol[from] && vol[to]) return (qty * vol[from]) / vol[to];
  return null; // incompatible (PIECE vs GRAM etc.)
}

/**
 * Goods-receipt quantities for a purchase order, merged per ingredient.
 *
 * BUG FIX: the receipt fence is ONE PURCHASE ledger row per (ingredient, PO),
 * but a PO may list the same ingredient on several lines (split deliveries,
 * different unit prices). Receiving line by line let the first line's ledger
 * row fence out every later line for that ingredient, so their quantity was
 * silently never added to stock while the PO total still included it. Lines
 * are merged first (qty summed, unit cost = qty-weighted average; a single
 * line keeps its exact unit cost), then one fenced movement is recorded.
 */
export function aggregateReceiptLines(
  lines: ReadonlyArray<{ ingredientId: string; qty: number; unitCostMinor: number }>,
): Array<{ ingredientId: string; qty: number; unitCostMinor: number }> {
  const byIngredient = new Map<string, { qty: number; cost: number }>();
  for (const line of lines) {
    const agg = byIngredient.get(line.ingredientId) ?? { qty: 0, cost: 0 };
    agg.qty += line.qty;
    agg.cost += line.qty * line.unitCostMinor;
    byIngredient.set(line.ingredientId, agg);
  }
  return [...byIngredient].map(([ingredientId, agg]) => ({
    ingredientId,
    qty: Math.round(agg.qty * 1e6) / 1e6,
    unitCostMinor: agg.qty > 0 ? Math.round(agg.cost / agg.qty) : 0,
  }));
}

/** Append a ledger movement atomically; returns the new balance.
 *
 * AUDIT FIX (P16-INV-1): the previous read-modify-write (`stockQty = read +
 * delta` absolute write) lost updates under concurrency and diverged the
 * ledger's balanceAfter chain from real stock. The stock change is now an
 * ATOMIC DB increment; the resulting balance is read back in the same
 * transaction (callers without a tx get an internal one), so N concurrent
 * movements always serialize correctly. The floor-at-zero check throws to
 * roll the increment back when stock would go negative.
 */
export async function recordMovement(params: {
  hotelId: string;
  ingredientId: string;
  reason: "OPENING" | "PURCHASE" | "CONSUMPTION" | "WASTAGE" | "ADJUSTMENT" | "TRANSFER_IN" | "TRANSFER_OUT" | "RETURN";
  qtyDelta: number;
  unitCostMinor?: number | null;
  refType?: string | null;
  refId?: string | null;
  wastageReason?: string | null;
  note?: string | null;
  createdByUserId?: string | null;
  tx?: Parameters<Parameters<typeof db.$transaction>[0]>[0];
}) {
  const run = async (client: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => {
    const ingredient = await client.ingredient.findFirst({
      where: { id: params.ingredientId, hotelId: params.hotelId },
    });
    if (!ingredient) throw new Error("Ingredient not found.");
    // ATOMIC increment (no lost updates). The sign of qtyDelta decides.
    const after = await client.ingredient.update({
      where: { id: ingredient.id },
      data: {
        stockQty: { increment: params.qtyDelta },
        ...(params.unitCostMinor != null && params.reason === "PURCHASE" ? { costPerUnitMinor: params.unitCostMinor } : {}),
      },
    });
    const balanceAfter = Math.round(after.stockQty * 1e6) / 1e6;
    if (balanceAfter < 0) {
      // Throwing rolls the increment back with the surrounding transaction.
      throw new Error(`Insufficient stock for ${ingredient.name}: would go to ${balanceAfter} ${ingredient.unit}.`);
    }
    const entry = await client.stockLedger.create({
      data: {
        hotelId: params.hotelId,
        ingredientId: ingredient.id,
        reason: params.reason,
        qtyDelta: params.qtyDelta,
        balanceAfter,
        unitCostMinor: params.unitCostMinor ?? null,
        refType: params.refType ?? null,
        refId: params.refId ?? null,
        wastageReason: params.wastageReason ?? null,
        note: params.note ?? null,
        createdByUserId: params.createdByUserId ?? null,
      },
    });
    return { entry, balanceAfter };
  };
  return params.tx ? run(params.tx) : db.$transaction(run, { timeout: 30_000 });
}

/**
 * Deduct recipe consumption for a paid bill — EXACTLY ONCE per bill
 * (ledger unique fence). Called from the RESTAURANT_BILL_PAID job handler.
 * Returns per-ingredient results; a missing recipe simply deducts nothing.
 */
export async function consumeStockForBill(hotelId: string, billId: string): Promise<{ deducted: number; skipped: number; insufficient: string[] }> {
  const bill = await db.bill.findUnique({ where: { id: billId }, select: { id: true, hotelId: true } });
  if (!bill) return { deducted: 0, skipped: 0, insufficient: [] };

  // Resolve quantities per menu item from the source orders' items.
  const orderIds = await db.billLine.findMany({ where: { billId }, select: { orderId: true } });
  const items = await db.orderItem.findMany({
    where: {
      orderId: { in: [...new Set(orderIds.map((l) => l.orderId).filter((x): x is string => x !== null))] },
      // AUDIT FIX (P16-INV-2): CANCELLED items were counted for stock
      // consumption while bill lines exclude them — stock was over-deducted
      // for cancelled orders. Consumption must mirror what was billed.
      status: { not: "CANCELLED" },
    },
    select: { menuItemId: true, quantity: true },
  });
  const qtyByItem = new Map<string, number>();
  for (const it of items) {
    if (!it.menuItemId) continue;
    qtyByItem.set(it.menuItemId, (qtyByItem.get(it.menuItemId) ?? 0) + it.quantity);
  }
  if (qtyByItem.size === 0) return { deducted: 0, skipped: 0, insufficient: [] };

  const recipes = await db.recipeLine.findMany({
    where: { hotelId, menuItemId: { in: [...qtyByItem.keys()] } },
    include: { ingredient: { select: { id: true, name: true, unit: true } } },
  });

  // AUDIT FIX (P16-INV-3): when BOTH a base recipe (variantKey = null) and a
  // variant-specific recipe exist for the same (menu item, ingredient), the
  // old code applied both and double-counted. A base line for an ingredient
  // that has variant lines is superseded by them (deterministic policy —
  // variant matching needs an options-signature contract, tracked separately).
  const hasVariantLine = new Set(
    recipes.filter((r) => r.variantKey !== null).map((r) => `${r.menuItemId}|${r.ingredientId}`),
  );

  // Aggregate requirement per ingredient first — one ledger row per
  // (ingredient, BILL, CONSUMPTION) keeps the fence simple.
  const need = new Map<string, { qty: number; unit: string; name: string }>();
  for (const line of recipes) {
    if (line.variantKey === null && hasVariantLine.has(`${line.menuItemId}|${line.ingredientId}`)) {
      continue; // superseded by variant-specific recipes for this ingredient
    }
    const servings = qtyByItem.get(line.menuItemId) ?? 0;
    if (servings <= 0) continue;
    const prev = need.get(line.ingredientId);
    need.set(line.ingredientId, {
      qty: (prev?.qty ?? 0) + line.qtyPerUnit * servings,
      unit: line.ingredient.unit,
      name: line.ingredient.name,
    });
  }

  let deducted = 0;
  const insufficient: string[] = [];
  for (const [ingredientId, req] of need) {
    try {
      await db.$transaction(
        async (tx) => {
          // Fence: a ledger row for this (ingredient, BILL) already exists → skip.
          const fence = await tx.stockLedger.findUnique({
            where: {
              ingredientId_refType_refId_reason: {
                ingredientId,
                refType: "BILL",
                refId: billId,
                reason: "CONSUMPTION",
              },
            },
          });
          if (fence) return;
          await recordMovement({
            hotelId,
            ingredientId,
            reason: "CONSUMPTION",
            qtyDelta: -Math.round(req.qty * 1e6) / 1e6,
            refType: "BILL",
            refId: billId,
            note: `Recipe consumption for bill ${billId.slice(0, 8)} (${req.name})`,
            tx,
          });
        },
        { timeout: 30_000 },
      );
      deducted += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Insufficient stock")) insufficient.push(`${req.name}: ${msg}`);
      else throw err;
    }
  }
  return { deducted, skipped: need.size - deducted - insufficient.length, insufficient };
}

/** Recipe cost estimate per menu item (last-cost basis; labelled estimate). */
export async function recipeCostEstimate(hotelId: string, menuItemId: string): Promise<{ costMinor: number; lines: Array<{ name: string; qty: number; unit: string; costMinor: number }> } | null> {
  const lines = await db.recipeLine.findMany({
    where: { hotelId, menuItemId },
    include: { ingredient: { select: { name: true, unit: true, costPerUnitMinor: true } } },
  });
  if (lines.length === 0) return null;
  let total = 0;
  const out = lines.map((l) => {
    const cost = Math.round(l.qtyPerUnit * l.ingredient.costPerUnitMinor);
    total += cost;
    return { name: l.ingredient.name, qty: l.qtyPerUnit, unit: l.ingredient.unit, costMinor: cost };
  });
  return { costMinor: total, lines: out };
}

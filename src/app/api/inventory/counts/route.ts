import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { recordMovement } from "@/lib/inventory";

/**
 * Phase 16 — stock counts.
 * GET  /api/inventory/counts?open=1 — list counts (with lines)
 * POST /api/inventory/counts — start a count { } (system qty snapshot per line)
 * PATCH /api/inventory/counts — { id, lines: [{ingredientId, countedQty}] }
 *         → record counted values; { id, action: "COMPLETE" } → apply deltas
 *           as ADJUSTMENT ledger entries (exactly-once via fence).
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "INVENTORY_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const openOnly = url.searchParams.get("open") === "1";
    const counts = await db.stockCount.findMany({
      where: { hotelId: auth.user.hotelId, ...(openOnly ? { status: "OPEN" } : {}) },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: { lines: { include: { ingredient: { select: { name: true, unit: true } } } } },
    });
    return Response.json({ counts });
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

    // Snapshot current system quantities for all active ingredients.
    const ingredients = await db.ingredient.findMany({
      where: { hotelId: auth.user.hotelId, active: true },
    });
    const count = await db.stockCount.create({
      data: {
        hotelId: auth.user.hotelId!,
        status: "OPEN",
        countedByUserId: auth.user.userId,
        lines: {
          create: ingredients.map((i) => ({
            ingredientId: i.id,
            systemQty: i.stockQty,
            countedQty: i.stockQty,
            delta: 0,
          })),
        },
      },
      include: { lines: { include: { ingredient: { select: { name: true, unit: true } } } } },
    });
    return Response.json({ count }, { status: 201 });
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
    if (!body || typeof body.id !== "string") return jsonError("Expected { id, ... }.", 422, "INVALID_INPUT");
    const count = await db.stockCount.findFirst({
      where: { id: body.id, hotelId: auth.user.hotelId },
      include: { lines: true },
    });
    if (!count) return jsonError("Count not found.", 404, "NOT_FOUND");

    if (body.action === "COMPLETE") {
      if (count.status !== "OPEN") return jsonError("Count already completed.", 422, "INVALID_STATE");
      for (const line of count.lines) {
        if (line.delta === 0) continue;
        await db.$transaction(
          async (tx) => {
            const fence = await tx.stockLedger.findUnique({
              where: {
                ingredientId_refType_refId_reason: {
                  ingredientId: line.ingredientId,
                  refType: "STOCK_COUNT",
                  refId: count.id,
                  reason: "ADJUSTMENT",
                },
              },
            });
            if (fence) return;
            await recordMovement({
              hotelId: auth.user.hotelId!,
              ingredientId: line.ingredientId,
              reason: "ADJUSTMENT",
              qtyDelta: line.delta,
              refType: "STOCK_COUNT",
              refId: count.id,
              note: `Stock count ${count.id.slice(0, 8)}`,
              createdByUserId: auth.user.userId,
              tx,
            });
          },
          { timeout: 30_000 },
        );
      }
      const updated = await db.stockCount.update({
        where: { id: count.id },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      return Response.json({ count: updated });
    }

    // Record counted quantities.
    if (!Array.isArray(body.lines)) return jsonError("lines array is required.", 422, "INVALID_INPUT");
    for (const raw of body.lines as unknown[]) {
      const l = raw as Record<string, unknown>;
      if (typeof l.ingredientId !== "string" || !Number.isFinite(Number(l.countedQty))) continue;
      const line = count.lines.find((cl) => cl.ingredientId === l.ingredientId);
      if (!line) continue;
      const counted = Math.max(0, Number(l.countedQty));
      await db.stockCountLine.update({
        where: { id: line.id },
        data: { countedQty: counted, delta: Math.round((counted - line.systemQty) * 1e6) / 1e6 },
      });
    }
    const fresh = await db.stockCount.findUnique({
      where: { id: count.id },
      include: { lines: { include: { ingredient: { select: { name: true, unit: true } } } } },
    });
    return Response.json({ count: fresh });
  } catch (err) {
    return serverError(err);
  }
}

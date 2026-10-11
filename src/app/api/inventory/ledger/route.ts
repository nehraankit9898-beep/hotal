import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { recordMovement } from "@/lib/inventory";
import { logAudit } from "@/lib/audit";

/**
 * Phase 16 — stock ledger movements.
 * GET  /api/inventory/ledger?ingredientId=&limit= — movement history
 * POST /api/inventory/ledger — manual adjustment / wastage / return
 *   { ingredientId, reason: WASTAGE|ADJUSTMENT|RETURN|OPENING,
 *     qtyDelta (signed), wastageReason?, note? }
 * Purchases flow through purchase-order receipts; consumption through bills.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "INVENTORY_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const ingredientId = url.searchParams.get("ingredientId");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
    const entries = await db.stockLedger.findMany({
      where: { hotelId: auth.user.hotelId, ...(ingredientId ? { ingredientId } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { ingredient: { select: { name: true, unit: true } } },
    });
    return Response.json({ entries });
  } catch (err) {
    return serverError(err);
  }
}

const MANUAL_REASONS = ["WASTAGE", "ADJUSTMENT", "RETURN", "OPENING"];
const WASTAGE_REASONS = ["SPOILAGE", "BREAKAGE", "SAMPLING", "PREP_LOSS", "OTHER"];

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "INVENTORY_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");
    const ingredientId = typeof body.ingredientId === "string" ? body.ingredientId : "";
    const reason = body.reason;
    const qtyDelta = Number(body.qtyDelta);
    if (!ingredientId) return jsonError("ingredientId is required.", 422, "MISSING_FIELD");
    if (typeof reason !== "string" || !MANUAL_REASONS.includes(reason)) {
      return jsonError(`reason must be one of ${MANUAL_REASONS.join(", ")}.`, 422, "INVALID_REASON");
    }
    if (!Number.isFinite(qtyDelta) || qtyDelta === 0) {
      return jsonError("qtyDelta must be a non-zero number.", 422, "INVALID_QTY");
    }
    if (reason === "WASTAGE") {
      if (qtyDelta >= 0) return jsonError("Wastage deltas must be negative (stock out).", 422, "INVALID_QTY");
      if (typeof body.wastageReason !== "string" || !WASTAGE_REASONS.includes(body.wastageReason)) {
        return jsonError(`wastageReason must be one of ${WASTAGE_REASONS.join(", ")}.`, 422, "INVALID_WASTAGE_REASON");
      }
    }

    const result = await recordMovement({
      hotelId: auth.user.hotelId!,
      ingredientId,
      reason: reason as "WASTAGE" | "ADJUSTMENT" | "RETURN" | "OPENING",
      qtyDelta,
      wastageReason: reason === "WASTAGE" ? String(body.wastageReason) : null,
      note: typeof body.note === "string" ? body.note.slice(0, 300) : null,
      createdByUserId: auth.user.userId,
    }).catch((err: unknown) => {
      if (err instanceof Error && err.message.includes("Insufficient stock")) return null;
      throw err;
    });
    if (!result) return jsonError("Stock would go negative; adjust a smaller quantity.", 422, "INSUFFICIENT_STOCK");

    await logAudit({
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: "STOCK_MOVED",
      entityType: "StockLedger",
      entityId: result.entry.id,
      metadata: { ingredientId, reason, qtyDelta },
      req,
    });
    return Response.json({ entry: result.entry, balanceAfter: result.balanceAfter }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}

import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { adjustForVisitAmount, reverseForRestaurantVisit } from "@/lib/loyalty";
import { rebuildRestaurantAggregates } from "@/lib/restaurant";
import { parseWith, restaurantVisitPatchSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/restaurant/visits/[id] — edit a restaurant visit (Phase 6.4).
 *
 * Editing the bill amount creates a compensating VISIT_ADJUST loyalty ledger
 * entry (NEW − OLD points), so loyalty can never be corrupted by an edit
 * (spec: "₹10,000 → ₹1,000 must not keep 1,000 points"). Idempotent.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "RESTAURANT_WRITE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const visit = await db.restaurantVisit.findFirst({
      where: { id, hotelId },
      include: { customer: { select: { id: true, name: true } } },
    });
    if (!visit) return jsonError("Visit not found in your hotel.", 404, "NOT_FOUND");

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    // AUDIT FIX (F18): PATCH now shares the SAME validation schema as POST
    // (guests 1–50 integer, finite bounded amount, bounded strings) — the old
    // hand-rolled checks had drifted from create and accepted different input.
    const parsed = parseWith(restaurantVisitPatchSchema, body);
    if (!parsed.ok || !parsed.data)
      return jsonError(parsed.error ?? "Invalid request.", 422, "VALIDATION_ERROR");
    const input = parsed.data;

    const data: Record<string, unknown> = {};

    if (input.visitDate !== undefined) {
      const visitDate = new Date(String(input.visitDate));
      if (isNaN(visitDate.getTime())) return jsonError("Please provide a valid visit date.");
      data.visitDate = visitDate;
    }
    if (input.tableNumber !== undefined) data.tableNumber = input.tableNumber || null;
    if (input.guests !== undefined) data.guests = input.guests;
    if (input.orderAmount !== undefined)
      data.orderAmount = Math.round(input.orderAmount * 100) / 100;
    if (input.foodCategory !== undefined) data.foodCategory = input.foodCategory || null;
    if (input.notes !== undefined) data.notes = input.notes || null;

    if (Object.keys(data).length === 0) return jsonError("Nothing to update.");

    const oldAmount = visit.orderAmount;
    const newAmount =
      typeof data.orderAmount === "number" ? (data.orderAmount as number) : oldAmount;
    const amountChanged = newAmount !== oldAmount;

    const updated = await db.restaurantVisit.update({ where: { id: visit.id }, data });

    // AUDIT FIX (F08): editing a bill (amount, date, …) previously left the
    // customer's aggregate spend stale (₹1,000 → ₹100 kept totalSpend=1000).
    // The shared rebuild recomputes spend, visit count and MAX(visitDate)
    // from the authoritative visit list — also fixing F09 for date edits.
    await rebuildRestaurantAggregates(visit.customerId);

    // Loyalty compensation: adjust earned points by the delta (idempotent).
    let loyalty: { pointsDelta: number; balance: number } | null = null;
    if (amountChanged) {
      try {
        const settings = await db.loyaltySettings.findUnique({ where: { hotelId } });
        if (!settings || settings.enabled) {
          const result = await adjustForVisitAmount(
            hotelId,
            visit.customerId,
            visit.id,
            oldAmount,
            newAmount,
            {
              userId,
              req,
            },
          );
          if (result.ok) loyalty = { pointsDelta: result.pointsDelta, balance: result.balance };
        }
      } catch (err) {
        console.error("[loyalty] visit-adjust failed:", err instanceof Error ? err.message : err);
      }
    }

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.RESTAURANT_VISIT_UPDATED,
      entityType: "restaurant_visit",
      entityId: visit.id,
      metadata: {
        customer: visit.customerId,
        fields: Object.keys(data),
        amountChanged,
        loyaltyDelta: loyalty?.pointsDelta ?? 0,
      },
    });

    return Response.json({ visit: updated, loyalty });
  } catch (err) {
    return serverError(err, "Restaurant visit could not be updated. Please try again.");
  }
}

/**
 * DELETE /api/restaurant/visits/[id] — delete an incorrectly recorded visit
 * (Phase 6.4). A compensating REVERSAL loyalty ledger entry removes the points
 * this visit earned (idempotent — repeated deletes no-op). Deletion also
 * refreshes the customer's aggregated restaurant statistics.
 */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "RESTAURANT_WRITE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const visit = await db.restaurantVisit.findFirst({
      where: { id, hotelId },
      include: { customer: { select: { id: true, name: true } } },
    });
    if (!visit) return jsonError("Visit not found in your hotel.", 404, "NOT_FOUND");

    // Reverse loyalty FIRST (while the visit still exists for context), then delete.
    let loyalty: { pointsReversed: number; balance: number } | null = null;
    try {
      const settings = await db.loyaltySettings.findUnique({ where: { hotelId } });
      if (!settings || settings.enabled) {
        const result = await reverseForRestaurantVisit(
          hotelId,
          visit.customerId,
          visit.id,
          visit.orderAmount,
          {
            userId,
            req,
          },
        );
        if (result.ok) loyalty = { pointsReversed: result.pointsReversed, balance: result.balance };
      }
    } catch (err) {
      console.error("[loyalty] visit-reversal failed:", err instanceof Error ? err.message : err);
    }

    await db.restaurantVisit.delete({ where: { id: visit.id } });

    // Refresh aggregated restaurant stats for the customer (shared rebuild —
    // same source of truth as create/edit; F08/F09 consistency).
    await rebuildRestaurantAggregates(visit.customerId);

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.RESTAURANT_VISIT_DELETED,
      entityType: "restaurant_visit",
      entityId: visit.id,
      metadata: {
        customer: visit.customerId,
        customerName: visit.customer.name,
        amount: visit.orderAmount,
        loyaltyReversed: loyalty?.pointsReversed ?? 0,
      },
    });

    return Response.json({ ok: true, message: "Visit deleted.", loyalty });
  } catch (err) {
    return serverError(err, "Restaurant visit could not be deleted. Please try again.");
  }
}

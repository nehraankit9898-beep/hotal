import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { hasPermission, requirePermission } from "@/lib/permissions";
import { transitionOrder, type DiningOrderStatus } from "@/lib/orders";

type Ctx = { params: Promise<{ id: string }> };

const VALID_STATUSES: DiningOrderStatus[] = ["PLACED", "PREPARING", "READY", "SERVED", "CANCELLED"];

/** Fields a KITCHEN_STAFF actor may see — no customer contact, no money,
 *  no tracking token (D02: the general order-detail endpoint used to leak
 *  all three to the kitchen role through ORDER_READ). */
function kitchenSafeOrder(order: Record<string, unknown>): Record<string, unknown> {
  const { customerPhone, publicToken, subtotalMinor, totalMinor, ...safe } = order as Record<
    string,
    unknown
  > & {
    items?: { unitPriceMinor?: unknown; lineTotalMinor?: unknown }[];
  };
  return {
    ...safe,
    customerPhone: undefined,
    publicToken: undefined,
    subtotalMinor: undefined,
    totalMinor: undefined,
    items: Array.isArray(safe.items)
      ? safe.items.map((i) => ({
          ...i,
          unitPriceMinor: undefined,
          lineTotalMinor: undefined,
        }))
      : safe.items,
  };
}

/**
 * GET   /api/orders/[id] — order detail with events (tenant-scoped)
 * PATCH /api/orders/[id] — status transition.
 *        Body: { to: "PREPARING"|"READY"|"SERVED"|"CANCELLED",
 *                reason?: string (required for CANCELLED — audited),
 *                expectedUpdatedAt?: ISO (optimistic concurrency) }
 *
 * Permission split (server-side, D03):
 *   - PREPARING/READY  → preparation transitions (ORDER_UPDATE — kitchen OK)
 *   - SERVED           → floor/service operation (ORDER_SERVE — NOT kitchen)
 *   - CANCELLED        → floor/manager operation (ORDER_CANCEL — NOT kitchen);
 *                        requires a reason; the event + reason are recorded
 *                        immutably.
 */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "ORDER_READ");
    if (denied) return denied;
    const { id } = await ctx.params;

    const order = await db.diningOrder.findFirst({
      where: { id, hotelId: auth.user.hotelId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        source: true,
        subtotalMinor: true,
        totalMinor: true,
        currency: true,
        notes: true,
        customerName: true,
        customerPhone: true,
        publicToken: true,
        placedAt: true,
        servedAt: true,
        cancelledAt: true,
        cancelReason: true,
        updatedAt: true,
        table: { select: { id: true, number: true, zone: true } },
        tableSessionId: true,
        items: {
          select: {
            id: true,
            menuItemId: true,
            nameSnapshot: true,
            quantity: true,
            unitPriceMinor: true,
            lineTotalMinor: true,
            optionsSnapshot: true,
            notes: true,
            status: true,
          },
        },
        events: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            type: true,
            actorType: true,
            actorName: true,
            metadata: true,
            createdAt: true,
          },
        },
      },
    });
    if (!order) return jsonError("Order not found.", 404, "NOT_FOUND");

    // D02: the kitchen role gets a kitchen-safe projection — customer PII,
    // financial totals and the public tracking token are stripped
    // SERVER-side (the KDS queue's safe field selection did not protect
    // this alternate detail endpoint). Cashier keeps totals (billing context).
    const isKitchen = auth.user.role === "KITCHEN_STAFF";
    return Response.json({ order: isKitchen ? kitchenSafeOrder(order) : order });
  } catch (err) {
    return serverError(err, "The order could not be loaded.");
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "ORDER_READ");
    if (denied) return denied;
    const { id } = await ctx.params;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const to = body.to as DiningOrderStatus;
    if (!VALID_STATUSES.includes(to)) {
      return jsonError(`Invalid target status. Use one of ${VALID_STATUSES.join(",")}.`);
    }
    if (to === "PLACED") {
      return jsonError("An order cannot go back to PLACED.", 400, "INVALID_TRANSITION");
    }

    // D03 — per-transition authorization (the generic ORDER_UPDATE check let
    // the kitchen serve orders and cancel them):
    //   preparation (PREPARING/READY) → ORDER_UPDATE
    //   serving (SERVED)              → ORDER_SERVE (waiter/floor/manager)
    //   cancellation (CANCELLED)      → ORDER_CANCEL (waiter/floor/manager)
    const requiredPermission =
      to === "SERVED" ? "ORDER_SERVE" : to === "CANCELLED" ? "ORDER_CANCEL" : "ORDER_UPDATE";
    const transitionDenied = requirePermission(auth.user, requiredPermission);
    if (transitionDenied) return transitionDenied;

    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (to === "CANCELLED" && reason.length < 3) {
      return jsonError("A cancellation reason is required (recorded in the audit trail).");
    }

    const result = await transitionOrder(auth.user.hotelId, id, to, {
      expectedUpdatedAt:
        typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined,
      actorType: "STAFF",
      actorId: auth.user.userId,
      actorName: auth.user.name,
      reason: reason || null,
    });

    if (!result.ok) {
      const status =
        result.reason === "NOT_FOUND" ? 404 : result.reason === "VERSION_CONFLICT" ? 409 : 400;
      const message =
        result.reason === "NOT_FOUND"
          ? "Order not found."
          : result.reason === "VERSION_CONFLICT"
            ? "This order was just updated by someone else. Refresh and try again."
            : "That status change is not allowed from the order's current state.";
      return jsonError(message, status, result.reason ?? "INVALID_TRANSITION");
    }
    return Response.json(result);
  } catch (err) {
    return serverError(err, "The order could not be updated.");
  }
}

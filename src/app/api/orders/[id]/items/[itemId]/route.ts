import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { transitionOrderItem, type OrderItemStatus } from "@/lib/orders";

type Ctx = { params: Promise<{ id: string; itemId: string }> };

const VALID_ITEM_STATUSES: OrderItemStatus[] = ["PENDING", "PREPARING", "READY", "SERVED", "CANCELLED"];

/**
 * PATCH /api/orders/[id]/items/[itemId] — item-level preparation status.
 *
 * This is the KDS's primary control: the kitchen marks individual items
 * PREPARING/READY as they cook; the whole-order status is DERIVED from the
 * item states by the service layer (all non-cancelled items READY → order
 * READY). Two kitchen staff racing on the same item cannot double-apply —
 * the transition is fenced on the item's current status.
 *
 * D03 — per-transition authorization (server-enforced preparation-vs-service
 * split): PREPARING/READY need ORDER_UPDATE (kitchen OK); SERVED needs
 * ORDER_SERVE (waiter/floor); CANCELLED needs ORDER_CANCEL. The kitchen can
 * no longer serve or cancel items.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "ORDER_READ");
    if (denied) return denied;
    const { id, itemId } = await ctx.params;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const to = body.to as OrderItemStatus;
    if (!VALID_ITEM_STATUSES.includes(to)) {
      return jsonError(`Invalid item status. Use one of ${VALID_ITEM_STATUSES.join(", ")}.`);
    }
    if (to === "PENDING") {
      return jsonError("An item cannot go back to PENDING.", 400, "INVALID_TRANSITION");
    }

    const requiredPermission =
      to === "SERVED" ? "ORDER_SERVE" : to === "CANCELLED" ? "ORDER_CANCEL" : "ORDER_UPDATE";
    const transitionDenied = requirePermission(auth.user, requiredPermission);
    if (transitionDenied) return transitionDenied;

    const result = await transitionOrderItem(auth.user.hotelId, id, itemId, to, {
      actorType: "STAFF",
      actorId: auth.user.userId,
      actorName: auth.user.name,
    });

    if (!result.ok) {
      const status =
        result.reason === "NOT_FOUND" ? 404 : result.reason === "VERSION_CONFLICT" ? 409 : 400;
      const message =
        result.reason === "NOT_FOUND"
          ? "Order item not found."
          : result.reason === "VERSION_CONFLICT"
            ? "This item was just updated by someone else. Refresh and try again."
            : "That item status change is not allowed from its current state.";
      return jsonError(message, status, result.reason ?? "INVALID_TRANSITION");
    }
    return Response.json(result);
  } catch (err) {
    return serverError(err, "The order item could not be updated.");
  }
}

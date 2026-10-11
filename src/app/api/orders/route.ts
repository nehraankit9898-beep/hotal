import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { createOrder, CartValidationError } from "@/lib/orders";
import type { DiningOrderStatus } from "@/lib/orders";

/**
 * Phase 13 — dining orders (staff side).
 *
 * GET  /api/orders?status=&tableId=&limit= — tenant-scoped order list
 * POST /api/orders — staff-placed order (waiter order taking). Uses the SAME
 *        pricing/state engine as the public QR flow: server-computed totals,
 *        immutable snapshots, idempotency key support.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "ORDER_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    // Multiple status params are AND'ed into an IN filter by the caller:
    //   /api/orders?status=PLACED&status=PREPARING&status=READY
    const statuses = url.searchParams
      .getAll("status")
      .filter((s): s is DiningOrderStatus =>
        ["PLACED", "PREPARING", "READY", "SERVED", "CANCELLED"].includes(s),
      );
    const tableId = url.searchParams.get("tableId");
    const sessionId = url.searchParams.get("sessionId");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 100);

    const orders = await db.diningOrder.findMany({
      where: {
        hotelId: auth.user.hotelId,
        ...(statuses.length > 0 ? { status: { in: statuses } } : {}),
        ...(tableId ? { tableId } : {}),
        ...(sessionId ? { tableSessionId: sessionId } : {}),
      },
      orderBy: { placedAt: "desc" },
      take: limit,
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
        placedAt: true,
        servedAt: true,
        updatedAt: true,
        table: { select: { id: true, number: true, zone: true } },
        tableSessionId: true,
        items: {
          select: {
            id: true,
            nameSnapshot: true,
            quantity: true,
            unitPriceMinor: true,
            lineTotalMinor: true,
            optionsSnapshot: true,
            notes: true,
            status: true,
          },
        },
      },
    });

    return Response.json({ orders });
  } catch (err) {
    return serverError(err, "Orders could not be loaded.");
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "ORDER_CREATE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body || !Array.isArray(body.cart)) {
      return jsonError("Send { cart: [{ menuItemId, quantity, optionIds?, notes? }], … }.");
    }

    const result = await createOrder({
      hotelId: auth.user.hotelId,
      cart: body.cart,
      // AUDIT FIX (P12-ORD-1): an empty/short idempotency key produced
      // `staff:<uid>:` — every later order sent with an empty key silently
      // replayed the first one. Mirror the public route's minimum length.
      idempotencyKey:
        typeof body.idempotencyKey === "string" &&
        body.idempotencyKey.length >= 8 &&
        body.idempotencyKey.length <= 80
          ? `staff:${auth.user.userId}:${body.idempotencyKey}`
          : undefined,
      tableSessionId: typeof body.tableSessionId === "string" ? body.tableSessionId : null,
      customerName: typeof body.customerName === "string" ? body.customerName : null,
      customerPhone: typeof body.customerPhone === "string" ? body.customerPhone : null,
      notes: typeof body.notes === "string" ? body.notes : null,
      placedByUserId: auth.user.userId,
      source: "STAFF",
    });

    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    if (err instanceof CartValidationError) {
      return jsonError(err.message, 400, err.code);
    }
    return serverError(err, "The order could not be placed.");
  }
}

import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { createOrder, CartValidationError } from "@/lib/orders";

/**
 * Phase 16 — offline PWA sync endpoint.
 *
 * POST /api/offline/sync — batch-sync orders captured on a device while
 * offline. Every entry carries a STABLE client-generated operation id which
 * maps to the server-side order idempotency fence, so:
 *  - duplicate sync (retry, reconnect, multi-device) produces ONE order;
 *  - stale price/stock is reconciled server-side (server pricing engine);
 *  - revoked staff fail auth before any write.
 *
 * Body: { operations: [{ clientOpId, tableSessionToken?, cart: [...],
 *                        customerName?, customerPhone?, notes? }] }
 * Response: per-op results { clientOpId, ok, orderId?, error? } — partial
 * success allowed; the client keeps failed ops in its outbox for retry.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "ORDER_CREATE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body || !Array.isArray(body.operations)) {
      return jsonError("Expected { operations: [...] }.", 422, "INVALID_INPUT");
    }
    const ops = (body.operations as unknown[]).slice(0, 50);
    const results: Array<Record<string, unknown>> = [];

    for (const raw of ops) {
      const op = raw as Record<string, unknown>;
      const clientOpId = typeof op.clientOpId === "string" ? op.clientOpId.slice(0, 64) : "";
      if (!clientOpId) {
        results.push({ clientOpId: null, ok: false, error: "Missing clientOpId (stable client operation id is required)." });
        continue;
      }
      // Idempotency: reuse the op id as the order idempotency fence (scoped
      // by a prefix so public/customer keys can never collide with it).
      const idempotencyKey = `offline:${auth.user.hotelId}:${auth.user.userId}:${clientOpId}`;
      const existing = await db.diningOrder.findUnique({ where: { idempotencyKey } });
      if (existing) {
        results.push({ clientOpId, ok: true, orderId: existing.id, orderNumber: existing.orderNumber, duplicate: true });
        continue;
      }
      if (!Array.isArray(op.cart) || op.cart.length === 0) {
        results.push({ clientOpId, ok: false, error: "Empty cart." });
        continue;
      }
      // Resolve the table session server-side. Staff offline orders attach
      // to an OPEN session via tableSessionId (hotel-scoped revalidation) or
      // the session's public token. Closed/revoked sessions reject with
      // SESSION_CLOSED; cross-tenant ids are indistinguishable from missing.
      let tableSessionId: string | null = null;
      if (typeof op.tableSessionId === "string" && op.tableSessionId) {
        const session = await db.tableSession.findFirst({
          where: { id: op.tableSessionId, hotelId: auth.user.hotelId },
          select: { id: true, status: true },
        });
        if (!session) {
          results.push({ clientOpId, ok: false, error: "Invalid table session.", code: "SESSION_INVALID" });
          continue;
        }
        if (session.status !== "OPEN") {
          results.push({ clientOpId, ok: false, error: "Table session is closed; reopen and resync.", code: "SESSION_CLOSED" });
          continue;
        }
        tableSessionId = session.id;
      } else if (typeof op.tableSessionToken === "string" && op.tableSessionToken) {
        const session = await db.tableSession.findUnique({
          where: { publicToken: op.tableSessionToken },
          select: { id: true, hotelId: true, status: true },
        });
        if (!session || session.hotelId !== auth.user.hotelId) {
          results.push({ clientOpId, ok: false, error: "Invalid table session.", code: "SESSION_INVALID" });
          continue;
        }
        if (session.status !== "OPEN") {
          results.push({ clientOpId, ok: false, error: "Table session is closed; reopen and resync.", code: "SESSION_CLOSED" });
          continue;
        }
        tableSessionId = session.id;
      }
      try {
        const result = await createOrder({
          hotelId: auth.user.hotelId!,
          source: "STAFF",
          cart: op.cart as never,
          tableSessionId,
          placedByUserId: auth.user.userId,
          customerName: typeof op.customerName === "string" ? op.customerName.slice(0, 80) : null,
          customerPhone: typeof op.customerPhone === "string" ? op.customerPhone.slice(0, 20) : null,
          notes: typeof op.notes === "string" ? op.notes.slice(0, 300) : null,
          idempotencyKey,
        });
        results.push({
          clientOpId,
          ok: true,
          orderId: result.order.id,
          orderNumber: result.order.orderNumber,
          pricedTotalMinor: result.order.totalMinor,
        });
      } catch (err) {
        if (err instanceof CartValidationError) {
          results.push({ clientOpId, ok: false, error: err.message, code: err.code });
        } else {
          throw err;
        }
      }
    }

    return Response.json({ results, syncedAt: new Date().toISOString() });
  } catch (err) {
    return serverError(err);
  }
}

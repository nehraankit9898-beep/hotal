import { jsonError, readJson, serverError } from "@/lib/api-helpers";
import { createOrder, CartValidationError } from "@/lib/orders";
import { checkRateLimit } from "@/lib/rate-limit";
import { requestIp } from "@/lib/login-security";
import { db } from "@/lib/db";

/**
 * POST /api/public/orders — a diner submits their cart (Phase 13).
 *
 * Body: {
 *   sessionToken: string,   // the table session's public token (from the QR)
 *   idempotencyKey: string, // client UUID — retries return the same order
 *   cart: [{ menuItemId, quantity, optionIds?, notes? }],
 *   customerName?, customerPhone?, notes?
 * }
 *
 * Security/reliability contract:
 *  - The session token is the diner's ONLY capability: it is looked up, must
 *    be OPEN, and scopes the order to that table's session. No tenant id is
 *    ever accepted from the client.
 *  - PRICING IS SERVER-COMPUTED from the current catalog (priceCart) — the
 *    submitted cart carries ids and quantities only.
 *  - IDEMPOTENT: the same idempotencyKey returns the original order. A mobile
 *    network timeout + user retry never creates a duplicate order.
 *  - Rate-limited per IP (an unattended QR must not enable spam ordering).
 *  - Guest identity (name/phone) is OPTIONAL and separate from marketing —
 *    no consent is implied by ordering (product policy, Phase 13 §2).
 */
export async function POST(req: Request) {
  try {
    // Origin check for this public mutation.
    const { assertCsrf } = await import("@/lib/csrf");
    const csrf = assertCsrf(req, { hasCookieSession: false, bearerSession: false });
    if (!csrf.ok && csrf.status && csrf.code) {
      return jsonError(csrf.message ?? "Request blocked.", csrf.status, csrf.code);
    }

    // Anti-spam: a static QR in the wild must not enable unlimited unattended
    // ordering. 12 submits/10 min/IP is generous for a human table.
    const burst = await checkRateLimit(`public-order:${requestIp(req)}`, 12, 10 * 60 * 1000);
    if (!burst.allowed) {
      return jsonError("Too many orders from this device. Please ask our staff for help.", 429, "RATE_LIMITED");
    }

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const sessionToken =
      typeof body.sessionToken === "string" ? body.sessionToken.trim() : "";
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(sessionToken)) {
      return jsonError("Your table session is no longer valid. Please scan the table QR again.", 403, "SESSION_INVALID");
    }
    const session = await db.tableSession.findUnique({
      where: { publicToken: sessionToken },
      select: { id: true, hotelId: true, status: true },
    });
    if (!session || session.status !== "OPEN") {
      return jsonError("This table session is closed. Please ask our staff to reopen the table.", 409, "SESSION_CLOSED");
    }

    const idempotencyKey =
      typeof body.idempotencyKey === "string" && body.idempotencyKey.length >= 8 && body.idempotencyKey.length <= 80
        ? `qr:${sessionToken}:${body.idempotencyKey}`
        : null;
    if (!idempotencyKey) {
      return jsonError("Missing order key. Please refresh the page and try again.", 400, "MISSING_IDEMPOTENCY_KEY");
    }
    if (!Array.isArray(body.cart)) {
      return jsonError("Your cart is empty.", 400, "EMPTY_CART");
    }

    const result = await createOrder({
      hotelId: session.hotelId,
      cart: body.cart,
      idempotencyKey,
      tableSessionId: session.id,
      customerName: typeof body.customerName === "string" ? body.customerName : null,
      customerPhone: typeof body.customerPhone === "string" ? body.customerPhone : null,
      notes: typeof body.notes === "string" ? body.notes : null,
      source: "QR_CUSTOMER",
    });

    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    if (err instanceof CartValidationError) {
      return jsonError(err.message, 400, err.code);
    }
    return serverError(err, "Your order could not be placed. Please try again or call our staff.");
  }
}

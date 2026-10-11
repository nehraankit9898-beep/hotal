import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { recordManualPayment } from "@/lib/billing";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/bills/[id]/pay — record a manual payment allocation.
 *
 * Split payments = several calls (or one call per mode). Each allocation is
 * validated against the remaining due; totals always conserve. MANUAL
 * payments are labelled "manually recorded" — never gateway-verified.
 *
 * Body: { method: "CASH"|"UPI"|"CARD"|"OTHER", amountMinor, reference?,
 *         cashSessionId?, idempotencyKey? }
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BILL_PAY");
    if (denied) return denied;

    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");

    const method = body.method;
    if (typeof method !== "string" || !["CASH", "UPI", "CARD", "ONLINE", "OTHER"].includes(method)) {
      return jsonError("Invalid payment method.", 422, "INVALID_METHOD");
    }
    // Gateway-collected payments never enter through this endpoint — they are
    // verified via /api/restaurant-payments/verify + webhook. A client-only
    // "ONLINE" claim is not a verified payment.
    if (method === "ONLINE") {
      return jsonError(
        "Online payments must be verified through the gateway flow (/api/restaurant-payments/*).",
        422,
        "GATEWAY_ONLY",
      );
    }
    const amountMinor = Number(body.amountMinor);
    if (!Number.isFinite(amountMinor) || Math.floor(amountMinor) !== amountMinor || amountMinor <= 0) {
      return jsonError("amountMinor must be a positive integer (minor units).", 422, "INVALID_AMOUNT");
    }

    const result = await recordManualPayment({
      hotelId: auth.user.hotelId,
      billId: id,
      recordedByUserId: auth.user.userId,
      method: method as "CASH" | "UPI" | "CARD" | "OTHER",
      amountMinor: Math.floor(amountMinor),
      reference: typeof body.reference === "string" ? body.reference.slice(0, 200) : null,
      cashSessionId: typeof body.cashSessionId === "string" ? body.cashSessionId : null,
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : null,
    });
    if (!result.ok) return jsonError(result.reason ?? "Payment rejected.", 422, "PAYMENT_REJECTED");
    return Response.json({ payment: result }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}

import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { restaurantGatewayCredentials } from "@/lib/billing";

/**
 * Phase 14 — ONLINE payment for restaurant bills via Razorpay.
 * SEPARATE domain from the SaaS subscription billing (/api/billing/*).
 *
 * POST /api/restaurant-payments/order
 *   Body: { billId } or { paymentLinkToken } (Phase 15 public link flow)
 * Creates a provider order for the bill's remaining due. Requires the
 * tenant's RAZORPAY integration; without credentials the response is an
 * honest 423 GATEWAY_NOT_CONFIGURED (never a silent fake).
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    // Cashiers create checkout orders as part of taking a payment.
    const denied = requirePermission(auth.user, "BILL_PAY");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");

    let billId = typeof body.billId === "string" ? body.billId : null;
    let hotelId = auth.user.hotelId;
    let amountMinor: number | null = null;

    if (!billId && typeof body.paymentLinkToken === "string") {
      const link = await db.paymentLink.findUnique({ where: { token: body.paymentLinkToken }, include: { bill: true } });
      if (!link || link.hotelId !== hotelId) return jsonError("Payment link not found.", 404, "NOT_FOUND");
      if (link.status !== "ACTIVE" || link.expiresAt < new Date()) {
        return jsonError("Payment link is no longer active.", 410, "LINK_INACTIVE");
      }
      billId = link.billId;
      amountMinor = link.amountMinor;
    }

    if (!billId) return jsonError("billId is required.", 422, "MISSING_BILL");

    const bill = await db.bill.findFirst({ where: { id: billId, hotelId } });
    if (!bill) return jsonError("Bill not found.", 404, "NOT_FOUND");
    if (["VOID", "REFUNDED", "PAID"].includes(bill.status)) {
      return jsonError(`Bill is ${bill.status.toLowerCase()}; nothing to pay.`, 422, "BILL_NOT_PAYABLE");
    }

    const due = amountMinor ?? bill.totalMinor - bill.paidMinor;
    if (due <= 0) return jsonError("Nothing due on this bill.", 422, "NOTHING_DUE");

    const creds = await restaurantGatewayCredentials(hotelId);
    if (!creds) {
      return jsonError(
        "Online payments are not configured for this restaurant. Ask the owner to connect Razorpay in Integrations.",
        423,
        "GATEWAY_NOT_CONFIGURED",
      );
    }

    // Create the provider order with the Razorpay Orders API.
    const authHeader = `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64")}`;
    let providerOrder: { id?: string } | null = null;
    try {
      const res = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          amount: due,
          currency: bill.currency,
          receipt: bill.billNumber,
          notes: { billId: bill.id, hotelId, domain: "RESTAURANT_POS" },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        return jsonError(`Gateway rejected the order (HTTP ${res.status}).`, 502, "GATEWAY_ERROR");
      }
      providerOrder = (await res.json()) as { id?: string };
    } catch {
      return jsonError("Gateway is unreachable; try again shortly.", 504, "GATEWAY_UNREACHABLE");
    }
    if (!providerOrder?.id) {
      return jsonError("Gateway did not return an order id.", 502, "GATEWAY_ERROR");
    }

    await db.billPayment.create({
      data: {
        hotelId,
        billId: bill.id,
        method: "ONLINE",
        source: "GATEWAY",
        status: "FAILED", // starts as intent; flips to CAPTURED only on verification
        amountMinor: due,
        currency: bill.currency,
        gateway: "RAZORPAY",
        gatewayOrderId: providerOrder.id,
        signatureVerified: false,
        recordedByUserId: auth.user.userId,
        meta: JSON.stringify({ kind: "ORDER_INTENT" }),
      },
    });

    // Publish the public key id for the checkout widget (safe — it's public).
    return Response.json(
      {
        gatewayOrderId: providerOrder.id,
        amountMinor: due,
        currency: bill.currency,
        keyId: creds.keyId,
        billId: bill.id,
      },
      { status: 201 },
    );
  } catch (err) {
    return serverError(err);
  }
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { db } from "@/lib/db";
import { jsonError, readJson } from "@/lib/api-helpers";
import { restaurantGatewayCredentials } from "@/lib/billing";
import { limitPaymentLinkRequest } from "@/lib/payment-link-limit";

type Ctx = { params: Promise<{ token: string }> };

/**
 * POST /api/pay/[token]/checkout — PUBLIC: create a gateway order for an
 * ACTIVE payment link. Scoped strictly to the link token; amount is the
 * link's frozen amount. Without tenant gateway credentials this returns an
 * honest 423 (never a fake "paid" path).
 */
export async function POST(req: Request, ctx: Ctx) {
  const limited = await limitPaymentLinkRequest(req, "checkout");
  if (limited) return limited;
  const { token } = await ctx.params;
  const body = await readJson(req).catch(() => ({}));
  void body;

  const link = await db.paymentLink.findUnique({
    where: { token },
    include: { bill: true, hotel: { select: { name: true } } },
  });
  if (!link) return jsonError("Payment link not found.", 404, "NOT_FOUND");
  if (link.status !== "ACTIVE" || link.expiresAt < new Date()) {
    return jsonError("This payment link is no longer active.", 410, "LINK_INACTIVE");
  }
  if (["VOID", "REFUNDED", "PAID"].includes(link.bill.status)) {
    return jsonError("This bill is already settled or cancelled.", 422, "BILL_NOT_PAYABLE");
  }

  const creds = await restaurantGatewayCredentials(link.hotelId);
  if (!creds) {
    return jsonError(
      "Online payment is not configured for this restaurant. Please pay at the counter.",
      423,
      "GATEWAY_NOT_CONFIGURED",
    );
  }

  const authHeader = `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64")}`;
  let providerOrder: { id?: string } | null = null;
  try {
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({
        amount: link.amountMinor,
        currency: link.currency,
        receipt: link.bill.billNumber,
        notes: { billId: link.billId, hotelId: link.hotelId, paymentLinkId: link.id, domain: "RESTAURANT_POS" },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return jsonError("Gateway rejected the order.", 502, "GATEWAY_ERROR");
    providerOrder = (await res.json()) as { id?: string };
  } catch {
    return jsonError("Gateway is unreachable; try again shortly.", 504, "GATEWAY_UNREACHABLE");
  }
  if (!providerOrder?.id) return jsonError("Gateway did not return an order id.", 502, "GATEWAY_ERROR");

  // Bind the intent to the bill (gateway capture flows through the shared
  // verification path — the webhook and verify endpoint both fence on it).
  await db.billPayment.create({
    data: {
      hotelId: link.hotelId,
      billId: link.billId,
      method: "ONLINE",
      source: "GATEWAY",
      status: "FAILED",
      amountMinor: link.amountMinor,
      currency: link.currency,
      gateway: "RAZORPAY",
      gatewayOrderId: providerOrder.id,
      signatureVerified: false,
      recordedByUserId: link.createdByUserId,
      meta: JSON.stringify({ kind: "LINK_INTENT", paymentLinkId: link.id }),
    },
  });
  await db.paymentLink.update({ where: { id: link.id }, data: { gatewayOrderId: providerOrder.id } });

  return Response.json({ keyId: creds.keyId, gatewayOrderId: providerOrder.id, amountMinor: link.amountMinor, currency: link.currency });
}

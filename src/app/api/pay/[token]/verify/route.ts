import { db } from "@/lib/db";
import { jsonError, readJson } from "@/lib/api-helpers";
import { verifyGatewaySignature, restaurantGatewayCredentials, recordGatewayCapture } from "@/lib/billing";
import { limitPaymentLinkRequest } from "@/lib/payment-link-limit";
import { settlePaymentLink } from "@/lib/payment-link-settle";

type Ctx = { params: Promise<{ token: string }> };

/**
 * POST /api/pay/[token]/verify — PUBLIC: server-side verification of the
 * checkout callback for a payment link. Signature check FIRST; amount bound
 * to the link; allocation idempotent via gatewayPaymentId fence.
 */
export async function POST(req: Request, ctx: Ctx) {
  const limited = await limitPaymentLinkRequest(req, "verify");
  if (limited) return limited;
  const { token } = await ctx.params;
  const body = await readJson(req);
  const gatewayOrderId = typeof body?.gatewayOrderId === "string" ? body.gatewayOrderId : "";
  const gatewayPaymentId = typeof body?.gatewayPaymentId === "string" ? body.gatewayPaymentId : "";
  const gatewaySignature = typeof body?.gatewaySignature === "string" ? body.gatewaySignature : "";
  if (!gatewayOrderId || !gatewayPaymentId || !gatewaySignature) {
    return jsonError("gatewayOrderId, gatewayPaymentId and gatewaySignature are required.", 422, "MISSING_FIELDS");
  }

  const link = await db.paymentLink.findUnique({ where: { token }, include: { bill: true } });
  if (!link) return jsonError("Payment link not found.", 404, "NOT_FOUND");

  // AUDIT FIX (P15-LNK-1): settlement never re-checked the link state, so a
  // REVOKED or EXPIRED link could still complete payment through its earlier
  // created intent. The link must be currently payable.
  if (link.status === "PAID") return jsonError("This payment link is already settled.", 409, "LINK_PAID");
  if (link.status === "VOID" || link.status === "REVOKED" || link.status === "EXPIRED") {
    return jsonError("This payment link is no longer payable.", 409, "LINK_INACTIVE");
  }
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
    return jsonError("This payment link has expired.", 410, "LINK_EXPIRED");
  }
  const linkBill = link.bill;
  if (!linkBill || ["VOID", "REFUNDED"].includes(linkBill.status)) {
    return jsonError("The underlying bill is no longer payable.", 409, "BILL_NOT_PAYABLE");
  }

  const intent = await db.billPayment.findFirst({ where: { gatewayOrderId, hotelId: link.hotelId } });
  if (!intent || intent.billId !== link.billId) {
    return jsonError("Unknown gateway order for this link.", 404, "NOT_FOUND");
  }

  const creds = await restaurantGatewayCredentials(link.hotelId);
  if (!creds) return jsonError("Gateway is not configured.", 423, "GATEWAY_NOT_CONFIGURED");
  if (!verifyGatewaySignature(gatewayOrderId, gatewayPaymentId, gatewaySignature, creds.keySecret)) {
    return jsonError("Payment signature verification failed.", 400, "SIGNATURE_INVALID");
  }

  const result = await recordGatewayCapture({
    hotelId: link.hotelId,
    intentPaymentId: intent.id,
    gatewayOrderId,
    gatewayPaymentId,
    expectedAmountMinor: intent.amountMinor,
  });
  if (!result.ok) return jsonError(result.reason ?? "Capture rejected.", 422, "CAPTURE_REJECTED");

  // Link settles on capture. PAY-001: never swallow a failure here — the money
  // is already allocated, so answer with a retryable 503 (the retry hits the
  // idempotent duplicate path in recordGatewayCapture and settles the link).
  const settled = await settlePaymentLink({ id: link.id, hotelId: link.hotelId, billId: link.billId });
  if (!settled) {
    return Response.json(
      { error: { code: "LINK_SETTLE_PENDING", message: "Payment received; confirmation is still being finalised. Please retry shortly." } },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
  return Response.json({ ok: true, billStatus: result.billStatus ?? null });
}

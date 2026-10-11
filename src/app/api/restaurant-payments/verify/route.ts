import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { verifyGatewaySignature, restaurantGatewayCredentials, recordGatewayCapture } from "@/lib/billing";

/**
 * Phase 14 — server-side verification of the restaurant checkout callback.
 * A frontend success callback alone NEVER activates a payment: this endpoint
 * re-verifies the HMAC signature server-side, binds order→bill→amount and
 * only then allocates the capture (idempotent by gatewayPaymentId).
 *
 * POST { gatewayOrderId, gatewayPaymentId, gatewaySignature }
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BILL_PAY");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");
    const gatewayOrderId = typeof body.gatewayOrderId === "string" ? body.gatewayOrderId : "";
    const gatewayPaymentId = typeof body.gatewayPaymentId === "string" ? body.gatewayPaymentId : "";
    const gatewaySignature = typeof body.gatewaySignature === "string" ? body.gatewaySignature : "";
    if (!gatewayOrderId || !gatewayPaymentId || !gatewaySignature) {
      return jsonError("gatewayOrderId, gatewayPaymentId and gatewaySignature are required.", 422, "MISSING_FIELDS");
    }

    const intent = await db.billPayment.findFirst({
      where: { gatewayOrderId, gateway: "RAZORPAY", hotelId: auth.user.hotelId },
      include: { bill: true },
    });
    if (!intent) return jsonError("Unknown gateway order for this restaurant.", 404, "NOT_FOUND");
    const bill = intent.bill;
    if (bill.hotelId !== auth.user.hotelId) return jsonError("Bill not found.", 404, "NOT_FOUND");

    const creds = await restaurantGatewayCredentials(auth.user.hotelId);
    if (!creds) return jsonError("Gateway is not configured.", 423, "GATEWAY_NOT_CONFIGURED");

    // Signature check FIRST — a forged callback never allocates money.
    if (!verifyGatewaySignature(gatewayOrderId, gatewayPaymentId, gatewaySignature, creds.keySecret)) {
      await db.billPayment.update({ where: { id: intent.id }, data: { status: "FAILED" } });
      return jsonError("Payment signature verification failed.", 400, "SIGNATURE_INVALID");
    }

    // Amount binding: the captured amount must equal the intent amount.
    const result = await recordGatewayCapture({
      hotelId: auth.user.hotelId,
      intentPaymentId: intent.id,
      gatewayOrderId,
      gatewayPaymentId,
      expectedAmountMinor: intent.amountMinor,
    });
    if (!result.ok) return jsonError(result.reason ?? "Capture rejected.", 422, "CAPTURE_REJECTED");
    return Response.json({ payment: result }, { status: 200 });
  } catch (err) {
    return serverError(err);
  }
}

import { NextResponse } from "next/server";
import { readJson, jsonError, serverError, requireAuth } from "@/lib/api-helpers";
import { confirmRazorpayCheckout } from "@/lib/saas/billing";
import { checkRateLimit } from "@/lib/rate-limit";
import { requestIp } from "@/lib/login-security";

/**
 * POST /api/billing/checkout/verify — RECHECK FIX (C).
 *
 * Server-side confirmation for the Razorpay Checkout browser callback:
 *   { paymentId, razorpayOrderId, razorpayPaymentId, razorpaySignature }
 *
 * The browser callback is NEVER trusted: the signature is verified with the
 * platform key secret, the payment entity is re-fetched from the Razorpay
 * API for authoritative amount/status, the event is bound to the invoice
 * (order/amount/currency) and only then is markPaymentPaid's idempotent
 * transactional confirmation run. Tenant-scoped: only the invoice's own
 * hotel can confirm it, owner/admin roles only (same rule as checkout).
 */
export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  if (auth.user.role !== "HOTEL_OWNER" && auth.user.role !== "HOTEL_ADMIN") {
    return jsonError("Only hotel owners/admins can manage billing.", 403, "FORBIDDEN");
  }
  try {
    const ip = requestIp(req);
    const burst = await checkRateLimit(`checkout-verify:${auth.user.hotelId}:${ip}`, 30, 60 * 1000);
    if (!burst.allowed) {
      return jsonError(
        "Too many verification attempts. Please try again shortly.",
        429,
        "RATE_LIMITED",
      );
    }

    const body = await readJson(req);
    const paymentId = typeof body?.paymentId === "string" ? body.paymentId : "";
    const razorpayOrderId =
      typeof body?.razorpayOrderId === "string" ? body.razorpayOrderId.trim() : "";
    const razorpayPaymentId =
      typeof body?.razorpayPaymentId === "string" ? body.razorpayPaymentId.trim() : "";
    const razorpaySignature =
      typeof body?.razorpaySignature === "string" ? body.razorpaySignature.trim() : "";
    if (!paymentId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return jsonError("Missing checkout confirmation fields.", 422, "VALIDATION_ERROR");
    }

    const result = await confirmRazorpayCheckout({
      hotelId: auth.user.hotelId,
      paymentId,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: { code: "CONFIRMATION_FAILED", message: result.error } },
        { status: result.status },
      );
    }
    return NextResponse.json({
      ok: true,
      status: result.status,
      alreadyPaid: result.alreadyPaid ?? false,
    });
  } catch (err) {
    return serverError(
      err,
      "Could not confirm the payment. If you were charged, the webhook will complete it automatically.",
    );
  }
}

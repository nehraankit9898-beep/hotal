import { NextResponse } from "next/server";
import { jsonError, serverError, requireAuth } from "@/lib/api-helpers";
import { db } from "@/lib/db";

/**
 * GET /api/billing/checkout/[paymentId] — RECHECK FIX (C).
 *
 * Payment status for the checkout UI: after the Razorpay Checkout modal
 * closes (or a webhook capture lands asynchronously) the frontend polls this
 * endpoint to show the honest invoice state (PENDING → PAID / FAILED)
 * instead of guessing. Tenant-scoped: foreign payment ids look like 404.
 */
export async function GET(req: Request, ctx: { params: Promise<{ paymentId: string }> }) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  try {
    const { paymentId } = await ctx.params;
    const payment = await db.payment.findFirst({
      where: { id: paymentId, hotelId: auth.user.hotelId },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        provider: true,
        amount: true,
        discountAmount: true,
        currency: true,
        billingCycle: true,
        failureReason: true,
        paidAt: true,
        createdAt: true,
      },
    });
    if (!payment) return jsonError("Payment not found in your hotel.", 404, "NOT_FOUND");
    return NextResponse.json({ payment });
  } catch (err) {
    return serverError(err, "Could not load the payment status.");
  }
}

import { db } from "@/lib/db";
import { jsonError } from "@/lib/api-helpers";
import { limitPaymentLinkRequest } from "@/lib/payment-link-limit";

type Ctx = { params: Promise<{ token: string }> };

/**
 * GET /api/pay/[token] — PUBLIC payment link status. Scoped to the token:
 * returns ONLY restaurant name, amount, currency and payability. Never other
 * bills, never customer personal data. Public read-only and cheap.
 */
export async function GET(req: Request, ctx: Ctx) {
  const limited = await limitPaymentLinkRequest(req, "read");
  if (limited) return limited;
  const { token } = await ctx.params;
  const link = await db.paymentLink.findUnique({
    where: { token },
    include: {
      bill: { select: { billNumber: true, status: true, paidMinor: true, totalMinor: true } },
      hotel: { select: { name: true, city: true } },
    },
  });
  if (!link) return jsonError("Payment link not found.", 404, "NOT_FOUND");

  if (link.status !== "ACTIVE" || link.expiresAt < new Date()) {
    return Response.json({
      status: link.status === "ACTIVE" ? "EXPIRED" : link.status,
      restaurantName: link.hotel.name,
    });
  }
  if (["VOID", "REFUNDED"].includes(link.bill.status)) {
    return Response.json({ status: "UNAVAILABLE", restaurantName: link.hotel.name });
  }
  return Response.json({
    status: "ACTIVE",
    restaurantName: link.hotel.name,
    city: link.hotel.city,
    amountMinor: link.amountMinor,
    currency: link.currency,
    billNumber: link.bill.billNumber,
    expiresAt: link.expiresAt.toISOString(),
  });
}

import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { redeemCoupon } from "@/lib/coupons";

/** POST /api/coupons/redeem — redeem a coupon for an order */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "COUPON_REDEEM");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request.");

    const code = typeof body.code === "string" ? body.code : "";
    const customerId = typeof body.customerId === "string" ? body.customerId : "";
    const orderAmount = Number(body.orderAmount ?? 0);
    const orderId = typeof body.orderId === "string" ? body.orderId : undefined;

    if (!code || !customerId) return jsonError("Coupon code and customer ID are required.");
    if (orderAmount < 0) return jsonError("Order amount cannot be negative.");

    const customer = await db.customer.findFirst({
      where: { id: customerId, hotelId: auth.user.hotelId },
    });
    if (!customer) return jsonError("Customer not found in your hotel.", 404);

    const result = await redeemCoupon(
      code,
      customerId,
      auth.user.hotelId,
      auth.user.userId,
      orderAmount,
      orderId,
    );

    return Response.json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    return serverError(err, "Coupon redemption failed.");
  }
}

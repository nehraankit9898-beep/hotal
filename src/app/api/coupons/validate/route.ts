import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { validateCoupon, computeDiscount } from "@/lib/coupons";

/** POST /api/coupons/validate — preview discount without redeeming */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "COUPON_READ");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request.");

    const code = typeof body.code === "string" ? body.code : "";
    const customerId = typeof body.customerId === "string" ? body.customerId : "";
    const orderAmount = Number(body.orderAmount ?? 0);

    if (!code || !customerId) return jsonError("Coupon code and customer ID are required.");

    const customer = await db.customer.findFirst({
      where: { id: customerId, hotelId: auth.user.hotelId },
    });
    if (!customer) return jsonError("Customer not found in your hotel.", 404, "NOT_FOUND");

    const validation = await validateCoupon(code, customerId, auth.user.hotelId, orderAmount);
    if (!validation.valid) {
      return Response.json({ valid: false, reason: validation.reason });
    }

    const coupon = await db.coupon.findUnique({
      where: { hotelId_code: { hotelId: auth.user.hotelId, code: validation.code! } },
    });
    if (!coupon) return jsonError("Coupon not found.", 404);

    const discount = computeDiscount(coupon, orderAmount);
    return Response.json({
      valid: true,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      discount,
      finalAmount: orderAmount - discount,
    });
  } catch (err) {
    return serverError(err, "Coupon could not be validated.");
  }
}

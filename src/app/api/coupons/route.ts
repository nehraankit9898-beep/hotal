import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { normalizeCouponCode, generateCouponCode } from "@/lib/coupons";

/** GET /api/coupons — list coupons for the hotel */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "COUPON_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const activeOnly = url.searchParams.get("active") === "true";

    const coupons = await db.coupon.findMany({
      where: activeOnly
        ? { hotelId: auth.user.hotelId, active: true }
        : { hotelId: auth.user.hotelId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { redemptions: true } } },
    });

    return Response.json({
      coupons: coupons.map((c) => ({
        id: c.id,
        code: c.code,
        description: c.description,
        discountType: c.discountType,
        discountValue: c.discountValue,
        minimumOrder: c.minimumOrder,
        maximumDiscount: c.maximumDiscount,
        validFrom: c.validFrom?.toISOString() ?? null,
        validUntil: c.validUntil?.toISOString() ?? null,
        usageLimit: c.usageLimit,
        customerLimit: c.customerLimit,
        active: c.active,
        totalRedemptions: c.totalRedemptions,
        totalDiscount: c.totalDiscount,
        redemptionsCount: c._count.redemptions,
        createdAt: c.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return serverError(err, "Coupons could not be loaded. Please try again.");
  }
}

/** POST /api/coupons — create a coupon */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "COUPON_CREATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const code = normalizeCouponCode(typeof body.code === "string" ? body.code : "");
    if (!code) return jsonError("Please enter a valid coupon code (letters and numbers only).");
    if (code.length < 4) return jsonError("Coupon code must be at least 4 characters long.");

    const existing = await db.coupon.findUnique({ where: { hotelId_code: { hotelId, code } } });
    if (existing) return jsonError("A coupon with this code already exists in your hotel.");

    const discountType = ["PERCENTAGE", "FIXED_AMOUNT", "CUSTOMER_SPECIFIC", "ONE_TIME"].includes(
      body.discountType as string,
    )
      ? (body.discountType as "PERCENTAGE" | "FIXED_AMOUNT" | "CUSTOMER_SPECIFIC" | "ONE_TIME")
      : "PERCENTAGE";
    const discountValue = Number(body.discountValue ?? 0);
    if (discountValue < 0) return jsonError("Discount value cannot be negative.");
    if (discountType === "PERCENTAGE" && discountValue > 100)
      return jsonError("Percentage discount cannot exceed 100%.");

    const coupon = await db.coupon.create({
      data: {
        hotelId,
        code,
        description:
          typeof body.description === "string" ? body.description.slice(0, 300) || null : null,
        discountType,
        discountValue,
        minimumOrder: body.minimumOrder !== undefined ? Number(body.minimumOrder) : null,
        maximumDiscount: body.maximumDiscount !== undefined ? Number(body.maximumDiscount) : null,
        validFrom: body.validFrom ? new Date(body.validFrom as string) : null,
        validUntil: body.validUntil ? new Date(body.validUntil as string) : null,
        usageLimit: Number(body.usageLimit ?? 0),
        customerLimit: Number(body.customerLimit ?? 1),
        active: body.active !== false,
      },
    });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.COUPON_ISSUED,
      entityType: "coupon",
      entityId: coupon.id,
      metadata: { code, discountType, discountValue },
    });

    return Response.json({ coupon }, { status: 201 });
  } catch (err) {
    return serverError(err, "Coupon could not be created. Please try again.");
  }
}

export { generateCouponCode };

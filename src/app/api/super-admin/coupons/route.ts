import { NextResponse } from "next/server";
import { readJson, jsonError, serverError, requireSuperAdminSession } from "@/lib/api-helpers";
import { createBillingCoupon, validateCouponInput, type CouponInput } from "@/lib/saas/coupons";
import { db } from "@/lib/db";

/**
 * Billing coupons — Phase 10 §7 (Super Admin only).
 *   GET  /api/super-admin/coupons   → list (incl. usage stats)
 *   POST /api/super-admin/coupons   → create
 */
export async function GET(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const url = new URL(req.url);
    const includeInactive = url.searchParams.get("all") === "1";
    const coupons = await db.billingCoupon.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return NextResponse.json({
      coupons: coupons.map((c) => ({
        id: c.id,
        code: c.code,
        description: c.description,
        discountType: c.discountType,
        percentOff: c.percentOff,
        amountOff: c.amountOff,
        maxDiscountAmount: c.maxDiscountAmount,
        minAmount: c.minAmount,
        usageLimit: c.usageLimit,
        perTenantLimit: c.perTenantLimit,
        usedCount: c.usedCount,
        startsAt: c.startsAt?.toISOString() ?? null,
        expiresAt: c.expiresAt?.toISOString() ?? null,
        applicablePlans: c.applicablePlans ? JSON.parse(c.applicablePlans) : null,
        isActive: c.isActive,
        createdAt: c.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return serverError(err, "Could not load coupons.");
  }
}

export async function POST(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const body = await readJson(req);
    if (!body) return jsonError("Invalid request body.", 400, "BAD_REQUEST");
    const invalid = validateCouponInput(body as Partial<CouponInput>);
    if (invalid) return jsonError(invalid, 422, "VALIDATION_ERROR");
    const coupon = await createBillingCoupon(body as unknown as CouponInput, guard.session.userId);
    return NextResponse.json({ coupon: { id: coupon.id, code: coupon.code } }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && /already exists/i.test(err.message)) {
      return jsonError(err.message, 409, "CONFLICT");
    }
    return serverError(err, "Could not create the coupon.");
  }
}

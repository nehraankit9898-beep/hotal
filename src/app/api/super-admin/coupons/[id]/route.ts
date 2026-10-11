import { NextResponse } from "next/server";
import { readJson, jsonError, serverError, requireSuperAdminSession } from "@/lib/api-helpers";
import {
  updateBillingCoupon,
  deleteBillingCoupon,
  validateCouponInput,
  type CouponInput,
} from "@/lib/saas/coupons";

/**
 * Billing coupon management — Phase 10 §7 (Super Admin only).
 *   PUT    /api/super-admin/coupons/:id → edit limits / validity / active
 *   DELETE /api/super-admin/coupons/:id → deactivate (history preserved)
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid request body.", 400, "BAD_REQUEST");
    const invalid = validateCouponInput(body as Partial<CouponInput>);
    if (invalid) return jsonError(invalid, 422, "VALIDATION_ERROR");
    const coupon = await updateBillingCoupon(
      id,
      body as Partial<CouponInput>,
      guard.session.userId,
    );
    return NextResponse.json({
      coupon: { id: coupon.id, code: coupon.code, isActive: coupon.isActive },
    });
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      return jsonError(err.message, 404, "NOT_FOUND");
    }
    return serverError(err, "Could not update the coupon.");
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const { id } = await ctx.params;
    const coupon = await deleteBillingCoupon(id, guard.session.userId);
    return NextResponse.json({ coupon: { id: coupon.id, code: coupon.code, isActive: false } });
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      return jsonError(err.message, 404, "NOT_FOUND");
    }
    return serverError(err, "Could not delete the coupon.");
  }
}

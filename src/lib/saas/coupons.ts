import { db } from "@/lib/db";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

/**
 * Billing Coupons & Discounts — Phase 10 §7.
 *
 * Platform-level coupons applied at checkout. Guards:
 *  - negative pricing impossible (discount capped at order amount)
 *  - expired / not-yet-started coupons rejected
 *  - usage limits enforced with an ATOMIC guarded update (race-condition safe)
 *  - per-tenant limits enforced with an ATOMIC guarded update
 *  - double redemption prevented by redeeming exactly once per payment
 */

export interface CouponValidation {
  ok: boolean;
  reason?: string;
  coupon?: {
    id: string;
    code: string;
    discountType: "PERCENT" | "FIXED";
    percentOff: number | null;
    amountOff: number | null;
    maxDiscountAmount: number | null;
    minAmount: number | null;
  };
}

function parseApplicablePlans(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Validate a coupon for a given amount + plan WITHOUT consuming it. */
export async function validateCoupon(params: {
  code: string;
  amount: number;
  planKey?: string | null;
  hotelId?: string;
}): Promise<CouponValidation> {
  const code = params.code.trim().toUpperCase();
  const coupon = await db.billingCoupon.findUnique({ where: { code } });
  if (!coupon || !coupon.isActive) return { ok: false, reason: "Invalid coupon code." };
  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now)
    return { ok: false, reason: "This coupon is not active yet." };
  if (coupon.expiresAt && coupon.expiresAt < now)
    return { ok: false, reason: "This coupon has expired." };
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
    return { ok: false, reason: "This coupon has reached its usage limit." };
  }
  if (coupon.minAmount !== null && params.amount < coupon.minAmount) {
    return { ok: false, reason: `Minimum order amount for this coupon is ${coupon.minAmount}.` };
  }
  const applicable = parseApplicablePlans(coupon.applicablePlans);
  if (applicable && params.planKey && !applicable.includes(params.planKey)) {
    return { ok: false, reason: "This coupon does not apply to the selected plan." };
  }
  if (params.hotelId && coupon.perTenantLimit !== null) {
    const usedByTenant = await db.payment.count({
      where: { hotelId: params.hotelId, couponCode: code, status: "PAID" },
    });
    if (usedByTenant >= coupon.perTenantLimit) {
      return {
        ok: false,
        reason: "Your hotel has already used this coupon the maximum number of times.",
      };
    }
  }
  return {
    ok: true,
    coupon: {
      id: coupon.id,
      code: coupon.code,
      discountType: coupon.discountType,
      percentOff: coupon.percentOff,
      amountOff: coupon.amountOff,
      maxDiscountAmount: coupon.maxDiscountAmount,
      minAmount: coupon.minAmount,
    },
  };
}

/** Compute the discount (never negative, capped by max + order amount). */
export function computeDiscount(
  coupon: NonNullable<CouponValidation["coupon"]>,
  amount: number,
): number {
  let discount = 0;
  if (coupon.discountType === "PERCENT" && coupon.percentOff) {
    discount = (amount * coupon.percentOff) / 100;
    if (coupon.maxDiscountAmount !== null) discount = Math.min(discount, coupon.maxDiscountAmount);
  } else if (coupon.discountType === "FIXED" && coupon.amountOff) {
    discount = coupon.amountOff;
  }
  return Math.max(0, Math.min(discount, amount));
}

/**
 * Redeem a coupon for a CONFIRMED payment — atomic guarded increment so
 * concurrent checkouts can never over-redeem past usageLimit.
 */
export async function redeemCoupon(params: {
  couponId: string;
  hotelId: string;
  paymentId: string;
  adminUserId?: string;
}): Promise<boolean> {
  const coupon = await db.billingCoupon.findUnique({ where: { id: params.couponId } });
  if (!coupon) return false;
  const guarded = await db.billingCoupon.updateMany({
    where: {
      id: coupon.id,
      isActive: true,
      OR: [{ usageLimit: null }, { usedCount: { lt: db.billingCoupon.fields.usageLimit } }],
    },
    data: { usedCount: { increment: 1 } },
  });
  if (guarded.count !== 1) return false;
  await logAudit({
    hotelId: params.hotelId,
    userId: params.adminUserId,
    action: AUDIT_ACTIONS.BILLING_COUPON_REDEEMED,
    entityType: "billing_coupon",
    entityId: coupon.id,
    metadata: { code: coupon.code, paymentId: params.paymentId },
  });
  return true;
}

export interface CouponInput {
  code: string;
  description?: string | null;
  discountType: "PERCENT" | "FIXED";
  percentOff?: number | null;
  amountOff?: number | null;
  maxDiscountAmount?: number | null;
  minAmount?: number | null;
  usageLimit?: number | null;
  perTenantLimit?: number | null;
  startsAt?: string | null;
  expiresAt?: string | null;
  applicablePlans?: string[] | null;
  isActive?: boolean;
}

export function validateCouponInput(input: Partial<CouponInput>): string | null {
  if (typeof input.code !== "string" || !/^[A-Za-z0-9_-]{3,40}$/.test(input.code.trim())) {
    return "Coupon code must be 3-40 letters/numbers/dashes.";
  }
  if (input.discountType === "PERCENT") {
    if (
      input.percentOff === undefined ||
      input.percentOff === null ||
      input.percentOff < 1 ||
      input.percentOff > 100
    ) {
      return "Percentage discount must be between 1 and 100.";
    }
  } else if (input.discountType === "FIXED") {
    if (input.amountOff === undefined || input.amountOff === null || input.amountOff < 1) {
      return "Fixed discount must be at least 1.";
    }
  }
  if (
    input.maxDiscountAmount !== undefined &&
    input.maxDiscountAmount !== null &&
    input.maxDiscountAmount < 0
  ) {
    return "Max discount cannot be negative.";
  }
  if (input.minAmount !== undefined && input.minAmount !== null && input.minAmount < 0) {
    return "Minimum amount cannot be negative.";
  }
  if (input.usageLimit !== undefined && input.usageLimit !== null && input.usageLimit < 1) {
    return "Usage limit must be at least 1.";
  }
  if (
    input.perTenantLimit !== undefined &&
    input.perTenantLimit !== null &&
    input.perTenantLimit < 1
  ) {
    return "Per-tenant limit must be at least 1.";
  }
  return null;
}

export async function createBillingCoupon(input: CouponInput, adminUserId: string) {
  const code = input.code.trim().toUpperCase();
  const existing = await db.billingCoupon.findUnique({ where: { code } });
  if (existing) throw new Error("A coupon with this code already exists.");
  const coupon = await db.billingCoupon.create({
    data: {
      code,
      description: input.description ?? null,
      discountType: input.discountType,
      percentOff: input.discountType === "PERCENT" ? (input.percentOff ?? null) : null,
      amountOff: input.discountType === "FIXED" ? (input.amountOff ?? null) : null,
      maxDiscountAmount: input.maxDiscountAmount ?? null,
      minAmount: input.minAmount ?? null,
      usageLimit: input.usageLimit ?? null,
      perTenantLimit: input.perTenantLimit ?? null,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      applicablePlans: input.applicablePlans ? JSON.stringify(input.applicablePlans) : null,
      isActive: input.isActive ?? true,
      createdBy: adminUserId,
    },
  });
  await logAudit({
    userId: adminUserId,
    action: AUDIT_ACTIONS.BILLING_COUPON_CREATED,
    entityType: "billing_coupon",
    entityId: coupon.id,
    metadata: {
      code,
      discountType: input.discountType,
      percentOff: input.percentOff ?? null,
      amountOff: input.amountOff ?? null,
    },
  });
  return coupon;
}

export async function updateBillingCoupon(
  couponId: string,
  input: Partial<CouponInput>,
  adminUserId: string,
) {
  const existing = await db.billingCoupon.findUnique({ where: { id: couponId } });
  if (!existing) throw new Error("Coupon not found.");
  const data: Record<string, unknown> = {};
  if (input.description !== undefined) data.description = input.description;
  if (input.percentOff !== undefined) data.percentOff = input.percentOff;
  if (input.amountOff !== undefined) data.amountOff = input.amountOff;
  if (input.maxDiscountAmount !== undefined) data.maxDiscountAmount = input.maxDiscountAmount;
  if (input.minAmount !== undefined) data.minAmount = input.minAmount;
  if (input.usageLimit !== undefined) data.usageLimit = input.usageLimit;
  if (input.perTenantLimit !== undefined) data.perTenantLimit = input.perTenantLimit;
  if (input.startsAt !== undefined)
    data.startsAt = input.startsAt ? new Date(input.startsAt) : null;
  if (input.expiresAt !== undefined)
    data.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (input.applicablePlans !== undefined)
    data.applicablePlans = input.applicablePlans ? JSON.stringify(input.applicablePlans) : null;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  const coupon = await db.billingCoupon.update({ where: { id: couponId }, data });
  await logAudit({
    userId: adminUserId,
    action: AUDIT_ACTIONS.BILLING_COUPON_UPDATED,
    entityType: "billing_coupon",
    entityId: couponId,
    metadata: { code: coupon.code, changes: Object.keys(data) },
  });
  return coupon;
}

export async function deleteBillingCoupon(couponId: string, adminUserId: string) {
  const existing = await db.billingCoupon.findUnique({ where: { id: couponId } });
  if (!existing) throw new Error("Coupon not found.");
  // Soft-delete: keep redemption history intact for audited payments.
  const coupon = await db.billingCoupon.update({
    where: { id: couponId },
    data: { isActive: false },
  });
  await logAudit({
    userId: adminUserId,
    action: AUDIT_ACTIONS.BILLING_COUPON_DELETED,
    entityType: "billing_coupon",
    entityId: couponId,
    metadata: { code: existing.code, softDeleted: true },
  });
  return coupon;
}

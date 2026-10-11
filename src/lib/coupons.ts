import { db } from "@/lib/db";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

/**
 * Coupon management — Phase 3
 *
 * Real validation, real redemption records, real limits enforced server-side.
 * No silent failures: every rejected redemption returns a structured reason.
 */

export interface CouponValidation {
  valid: boolean;
  reason?: string;
  code?: string;
}

export function normalizeCouponCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
}

/** Validate a coupon for a specific customer/order without redeeming it. */
export async function validateCoupon(
  code: string,
  customerId: string,
  hotelId: string,
  orderAmount?: number,
): Promise<CouponValidation> {
  const normalized = normalizeCouponCode(code);
  if (!normalized) return { valid: false, reason: "Coupon code is empty." };

  const coupon = await db.coupon.findUnique({
    where: { hotelId_code: { hotelId, code: normalized } },
    include: { redemptions: { where: { customerId } } },
  });
  if (!coupon) return { valid: false, reason: "Coupon code not found.", code: normalized };
  if (!coupon.active) return { valid: false, reason: "Coupon is inactive.", code: normalized };

  const now = new Date();
  if (coupon.validFrom && now < coupon.validFrom) {
    return { valid: false, reason: "Coupon is not yet active.", code: normalized };
  }
  if (coupon.validUntil && now > coupon.validUntil) {
    return { valid: false, reason: "Coupon has expired.", code: normalized };
  }

  if (coupon.usageLimit > 0 && coupon.totalRedemptions >= coupon.usageLimit) {
    return { valid: false, reason: "Coupon usage limit reached.", code: normalized };
  }
  if (coupon.customerLimit > 0 && coupon.redemptions.length >= coupon.customerLimit) {
    return {
      valid: false,
      reason: "You have already used this coupon the maximum number of times.",
      code: normalized,
    };
  }

  if (
    coupon.minimumOrder !== null &&
    orderAmount !== undefined &&
    orderAmount < coupon.minimumOrder
  ) {
    return {
      valid: false,
      reason: `Minimum order amount is ₹${coupon.minimumOrder?.toFixed(2)} for this coupon.`,
      code: normalized,
    };
  }

  return { valid: true, code: normalized };
}

/** Compute discount amount given coupon + order amount. */
export function computeDiscount(
  coupon: {
    discountType: string;
    discountValue: number;
    maximumDiscount: number | null;
    minimumOrder: number | null;
  },
  orderAmount: number,
): number {
  let discount = 0;
  if (coupon.discountType === "PERCENTAGE") {
    discount = (orderAmount * coupon.discountValue) / 100;
  } else {
    discount = coupon.discountValue; // FIXED_AMOUNT, CUSTOMER_SPECIFIC, ONE_TIME
  }
  if (coupon.maximumDiscount !== null && discount > coupon.maximumDiscount) {
    discount = coupon.maximumDiscount;
  }
  if (discount > orderAmount) discount = orderAmount;
  return Math.max(0, discount);
}

/**
 * Phase 13: per-coupon in-process serialization. On SQLite (dev/test) write
 * transactions are database-wide; queueing them keeps concurrent redemptions
 * deterministic. On PostgreSQL this is a contention optimization only —
 * correctness across processes is still arbitrated by the unique-constraint
 * slot reservation and the atomic increment inside the transaction.
 */
const couponLocks = new Map<string, Promise<unknown>>();

function withCouponLock<T>(couponId: string, fn: () => Promise<T>): Promise<T> {
  const previous = couponLocks.get(couponId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  couponLocks.set(
    couponId,
    next.catch(() => undefined),
  );
  // Opportunistic cleanup to keep the map bounded.
  if (couponLocks.size > 10_000) {
    for (const [k, v] of couponLocks) {
      if (k !== couponId && v === Promise.resolve()) couponLocks.delete(k);
    }
  }
  return next;
}

export interface RedemptionResult {
  ok: boolean;
  reason?: string;
  discountAmount: number;
  finalAmount: number;
  redemptionId?: string;
}

/** Redeem a coupon — atomically increments usage + creates a redemption record.
 *
 * Phase 13 — concurrency correctness (DB-arbitrated, works across processes):
 *  - GLOBAL limit: `totalRedemptions` is incremented with an atomic SQL
 *    increment inside the transaction; the post-increment value is checked and
 *    the transaction rolls back when the limit is exceeded. Concurrent
 *    increments serialize on the row lock, so the limit can never be exceeded.
 *  - PER-CUSTOMER limit: enforced via a slot reservation — the redemption row
 *    carries `redemptionSlot = <current count for this customer>` and the
 *    @@unique([couponId, customerId, redemptionSlot]) constraint makes a
 *    double-booking physically impossible. The losing concurrent transaction
 *    receives a P2002 and is rejected as "limit reached".
 *  - `validateCoupon()` is performed first for a friendly reason, but the
 *    authoritative enforcement happens inside the transaction.
 */
export async function redeemCoupon(
  code: string,
  customerId: string,
  hotelId: string,
  userId: string | null,
  orderAmount: number,
  orderId?: string,
): Promise<RedemptionResult> {
  const normalized = normalizeCouponCode(code);
  if (!normalized) {
    return {
      ok: false,
      reason: "Coupon code is empty.",
      discountAmount: 0,
      finalAmount: orderAmount,
    };
  }

  const coupon = await db.coupon.findUnique({
    where: { hotelId_code: { hotelId, code: normalized } },
  });
  if (!coupon)
    return { ok: false, reason: "Coupon not found.", discountAmount: 0, finalAmount: orderAmount };
  if (!coupon.active)
    return {
      ok: false,
      reason: "Coupon is inactive.",
      discountAmount: 0,
      finalAmount: orderAmount,
    };

  const now = new Date();
  if (coupon.validFrom && now < coupon.validFrom) {
    return {
      ok: false,
      reason: "Coupon is not yet active.",
      discountAmount: 0,
      finalAmount: orderAmount,
    };
  }
  if (coupon.validUntil && now > coupon.validUntil) {
    return {
      ok: false,
      reason: "Coupon has expired.",
      discountAmount: 0,
      finalAmount: orderAmount,
    };
  }
  if (coupon.minimumOrder !== null && orderAmount < coupon.minimumOrder) {
    return {
      ok: false,
      reason: `Minimum order amount is ₹${coupon.minimumOrder.toFixed(2)} for this coupon.`,
      discountAmount: 0,
      finalAmount: orderAmount,
    };
  }

  const discount = computeDiscount(coupon, orderAmount);
  const final = orderAmount - discount;

  try {
    const redemption = await withCouponLock(coupon.id, () =>
      db.$transaction(
        async (tx) => {
          // GLOBAL limit: atomic increment, checked post-increment (row-lock
          // serialized). Performed ONCE — a slot race below must not double-count.
          const updated = await tx.coupon.update({
            where: { id: coupon.id },
            data: {
              totalRedemptions: { increment: 1 },
              totalDiscount: { increment: discount },
            },
          });
          if (updated.usageLimit > 0 && updated.totalRedemptions > updated.usageLimit) {
            throw new Error("USAGE_LIMIT_EXCEEDED");
          }

          // PER-CUSTOMER limit: slot reservation with retry. Concurrent claims of
          // the same slot lose the unique-constraint race and recompute.
          for (let attempt = 0; attempt < 5; attempt++) {
            const usedByCustomer = await tx.couponRedemption.count({
              where: { couponId: coupon.id, customerId },
            });
            if (coupon.customerLimit > 0 && usedByCustomer >= coupon.customerLimit) {
              throw new Error("CUSTOMER_LIMIT_REACHED");
            }
            try {
              return await tx.couponRedemption.create({
                data: {
                  couponId: coupon.id,
                  customerId,
                  hotelId,
                  orderId: orderId ?? null,
                  orderAmount,
                  discountAmount: discount,
                  redemptionSlot: usedByCustomer,
                },
              });
            } catch (slotErr) {
              if (
                typeof slotErr === "object" &&
                slotErr !== null &&
                "code" in slotErr &&
                (slotErr as { code?: string }).code === "P2002"
              ) {
                continue; // slot race — recompute and retry
              }
              throw slotErr;
            }
          }
          throw new Error("SLOT_RETRY_EXHAUSTED");
        },
        // SQLite (dev) serializes write transactions; queued redemptions must
        // not be killed by Prisma's 5s default while waiting for the row lock.
        { timeout: 30_000, maxWait: 10_000 },
      ),
    );

    await logAudit({
      hotelId,
      userId,
      action: AUDIT_ACTIONS.COUPON_REDEEMED,
      entityType: "coupon",
      entityId: coupon.id,
      metadata: { code: coupon.code, customer: customerId, discount, orderId: orderId ?? null },
    });

    return {
      ok: true,
      discountAmount: discount,
      finalAmount: final,
      redemptionId: redemption.id,
    };
  } catch (err) {
    // Unique-constraint races (two concurrent redemptions of the customer's
    // last slot) surface as P2002 — reject as limit reached.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return {
        ok: false,
        reason: "You have already used this coupon the maximum number of times.",
        discountAmount: 0,
        finalAmount: orderAmount,
      };
    }
    if (err instanceof Error && err.message === "USAGE_LIMIT_EXCEEDED") {
      return {
        ok: false,
        reason: "Coupon usage limit reached just before redemption.",
        discountAmount: 0,
        finalAmount: orderAmount,
      };
    }
    if (err instanceof Error && err.message === "CUSTOMER_LIMIT_REACHED") {
      return {
        ok: false,
        reason: "You have already used this coupon the maximum number of times.",
        discountAmount: 0,
        finalAmount: orderAmount,
      };
    }
    if (err instanceof Error && err.message === "SLOT_RETRY_EXHAUSTED") {
      return {
        ok: false,
        reason: "Redemption is busy — please try again.",
        discountAmount: 0,
        finalAmount: orderAmount,
      };
    }
    throw err;
  }
}

/** Generate a unique coupon code (for admins who want a random code). */
export function generateCouponCode(prefix = "STAY"): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = prefix + "-";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

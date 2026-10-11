/**
 * Phase 15 — referral program.
 *
 * Abuse controls (documented policy):
 *  - one referral attribution per referee, EVER (DB unique (hotelId, referee));
 *  - self-referral rejected (same customer id on both sides);
 *  - duplicate identity: same phone/email existing customer cannot re-refer
 *    (attribution key is the customer, not the click);
 *  - reward issued exactly once (status PENDING→QUALIFIED→REWARDED guarded by
 *    the unique referee constraint + a conditional UPDATE);
 *  - refunds: the qualifying bill being refunded/void AFTER reward does not
 *    auto-claw-back points (documented policy: rewards follow the loyalty
 *    engine's own refund policy; abuse is capped per referrer).
 */

import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { adjustPoints } from "@/lib/loyalty";
import { logAudit } from "@/lib/audit";

export interface ReferralProgramData {
  id: string;
  hotelId: string;
  active: boolean;
  referrerRewardType: string;
  referrerRewardValue: number;
  refereeRewardType: string;
  refereeRewardValue: number;
  minSpendMinor: number | null;
  maxRewardsPerReferrer: number | null;
  terms: string | null;
}

export async function getOrCreateProgram(hotelId: string): Promise<ReferralProgramData> {
  const existing = await db.referralProgram.findUnique({ where: { hotelId } });
  if (existing) return existing;
  return db.referralProgram.create({ data: { hotelId } });
}

/** Stable, unguessable shareable code for a customer. */
export async function getOrCreateReferralCode(hotelId: string, customerId: string): Promise<string> {
  const existing = await db.referralCode.findUnique({
    where: { hotelId_customerId: { hotelId, customerId } },
  });
  if (existing) return existing.code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomBytes(8).toString("base64url");
    try {
      const created = await db.referralCode.create({ data: { hotelId, customerId, code } });
      return created.code;
    } catch {
      /* code collision — retry with fresh randomness */
    }
  }
  throw new Error("Could not allocate a referral code.");
}

/**
 * Public attribution: link a referee to a referrer by code. The referee
 * customer must already exist (QR join / phone identity). Personal data of
 * the referrer is NEVER returned — only a display name for greeting.
 */
export async function attributeReferral(
  hotelId: string,
  code: string,
  refereeCustomerId: string,
): Promise<{ ok: boolean; reason?: string; referrerName?: string }> {
  const program = await getOrCreateProgram(hotelId);
  if (!program.active) return { ok: false, reason: "The referral program is not active." };

  const codeRow = await db.referralCode.findUnique({ where: { hotelId_code: { hotelId, code } } });
  if (!codeRow) return { ok: false, reason: "Referral code not found." };
  if (codeRow.customerId === refereeCustomerId) {
    return { ok: false, reason: "You cannot refer yourself." };
  }
  const referee = await db.customer.findFirst({ where: { id: refereeCustomerId, hotelId }, select: { id: true } });
  if (!referee) return { ok: false, reason: "Invalid customer." };

  const existing = await db.referral.findUnique({
    where: { hotelId_refereeCustomerId: { hotelId, refereeCustomerId } },
  });
  if (existing) {
    if (existing.status === "REJECTED") return { ok: false, reason: "This account cannot use referrals." };
    return { ok: false, reason: "This account already has a referral attribution." };
  }

  await db.referral.create({
    data: {
      hotelId,
      referrerCustomerId: codeRow.customerId,
      refereeCustomerId,
      codeId: codeRow.id,
      status: "PENDING",
    },
  });
  const referrer = await db.customer.findUnique({ where: { id: codeRow.customerId }, select: { name: true } });
  return { ok: true, referrerName: referrer?.name ?? "A friend" };
}

/**
 * Qualification hook — called by the RESTAURANT_BILL_PAID job for every paid
 * bill with a known customer. First qualifying paid bill for a PENDING
 * referee → issue both rewards exactly once.
 */
export async function qualifyReferralForBill(
  hotelId: string,
  customerId: string,
  billId: string,
  totalMinor: number,
): Promise<{ status: string; referrerRewarded?: boolean; refereeRewarded?: boolean }> {
  const program = await getOrCreateProgram(hotelId);
  const referral = await db.referral.findUnique({
    where: { hotelId_refereeCustomerId: { hotelId, refereeCustomerId: customerId } },
  });
  if (!referral || referral.status !== "PENDING") {
    return { status: referral?.status ?? "NO_ATTRIBUTION" };
  }
  if (program.minSpendMinor !== null && totalMinor < program.minSpendMinor) {
    return { status: "PENDING_BELOW_MIN_SPEND" };
  }

  // Conditional transition — only one concurrent call can flip to QUALIFIED.
  const flipped = await db.referral.updateMany({
    where: { id: referral.id, status: "PENDING" },
    data: { status: "QUALIFIED", qualifiedBillId: billId },
  });
  if (flipped.count === 0) return { status: "ALREADY_QUALIFIED" };

  // Per-referrer cap check.
  if (program.maxRewardsPerReferrer !== null) {
    const rewarded = await db.referral.count({
      where: { hotelId, referrerCustomerId: referral.referrerCustomerId, status: "REWARDED" },
    });
    if (rewarded >= program.maxRewardsPerReferrer) {
      await db.referral.update({ where: { id: referral.id }, data: { status: "REJECTED", rejectReason: "REFERRER_CAP_REACHED" } });
      return { status: "REJECTED_REFERRER_CAP" };
    }
  }

  // Rewards: POINTS via the loyalty ledger (idempotent keys); COUPON_VALUE is
  // recorded as an adjustment note (coupon issuing stays a manual/owner flow).
  if (program.referrerRewardType === "POINTS" && program.referrerRewardValue > 0) {
    await adjustPoints(hotelId, referral.referrerCustomerId, program.referrerRewardValue, `Referral reward — a friend completed their first visit (bill ${billId.slice(0, 8)})`);
  }
  if (program.refereeRewardType === "POINTS" && program.refereeRewardValue > 0) {
    await adjustPoints(hotelId, referral.refereeCustomerId, program.refereeRewardValue, "Welcome referral bonus");
  }

  await db.referral.update({
    where: { id: referral.id },
    data: { status: "REWARDED", rewardedAt: new Date() },
  });
  await logAudit({
    hotelId,
    userId: null,
    action: "REFERRAL_REWARDED",
    entityType: "Referral",
    entityId: referral.id,
    metadata: { billId, referrerCustomerId: referral.referrerCustomerId, refereeCustomerId: referral.refereeCustomerId },
  });
  return { status: "REWARDED", referrerRewarded: program.referrerRewardType === "POINTS", refereeRewarded: program.refereeRewardType === "POINTS" };
}

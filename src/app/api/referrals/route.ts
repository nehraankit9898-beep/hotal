import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { getOrCreateProgram, getOrCreateReferralCode, attributeReferral } from "@/lib/referrals";

/**
 * Phase 15 — referral program.
 *
 * GET  /api/referrals — program config + summary records (owner/marketing)
 * PUT  /api/referrals — upsert program config (REFERRAL_MANAGE)
 * POST /api/referrals — { action: "code", customerId } → customer code
 *                       { action: "attribute", code, customerId } → link
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "REFERRAL_MANAGE");
    if (denied) return denied;

    const program = await getOrCreateProgram(auth.user.hotelId!);
    const [codes, referrals] = await Promise.all([
      db.referralCode.count({ where: { hotelId: auth.user.hotelId } }),
      db.referral.findMany({
        where: { hotelId: auth.user.hotelId },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true, status: true, referrerCustomerId: true, refereeCustomerId: true,
          qualifiedBillId: true, rewardedAt: true, rejectReason: true, createdAt: true,
          referrer: { select: { name: true } },
          referee: { select: { name: true } },
        },
      }),
    ]);
    // Aggregate view only — no personal data beyond display names.
    return Response.json({ program, stats: { totalCodes: codes }, referrals });
  } catch (err) {
    return serverError(err);
  }
}

export async function PUT(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "REFERRAL_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");
    const data: Record<string, unknown> = {};
    if (typeof body.active === "boolean") data.active = body.active;
    if (typeof body.referrerRewardType === "string" && ["POINTS", "COUPON_VALUE"].includes(body.referrerRewardType)) {
      data.referrerRewardType = body.referrerRewardType;
    }
    if (typeof body.referrerRewardValue === "number" && body.referrerRewardValue >= 0) {
      data.referrerRewardValue = Math.floor(body.referrerRewardValue);
    }
    if (typeof body.refereeRewardType === "string" && ["POINTS", "COUPON_VALUE"].includes(body.refereeRewardType)) {
      data.refereeRewardType = body.refereeRewardType;
    }
    if (typeof body.refereeRewardValue === "number" && body.refereeRewardValue >= 0) {
      data.refereeRewardValue = Math.floor(body.refereeRewardValue);
    }
    if (typeof body.minSpendMinor === "number" && body.minSpendMinor >= 0) data.minSpendMinor = Math.floor(body.minSpendMinor);
    if (typeof body.maxRewardsPerReferrer === "number" && body.maxRewardsPerReferrer > 0) {
      data.maxRewardsPerReferrer = Math.floor(body.maxRewardsPerReferrer);
    }
    if (typeof body.terms === "string") data.terms = body.terms.slice(0, 2000);
    if (Object.keys(data).length === 0) return jsonError("Nothing to update.", 422, "EMPTY_UPDATE");

    await getOrCreateProgram(auth.user.hotelId!);
    const program = await db.referralProgram.update({ where: { hotelId: auth.user.hotelId! }, data });
    return Response.json({ program });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOMER_READ");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");
    const customerId = typeof body.customerId === "string" ? body.customerId : "";
    const customer = await db.customer.findFirst({ where: { id: customerId, hotelId: auth.user.hotelId } });
    if (!customer) return jsonError("Customer not found.", 404, "NOT_FOUND");

    if (body.action === "code") {
      const code = await getOrCreateReferralCode(auth.user.hotelId!, customerId);
      return Response.json({ code });
    }
    if (body.action === "attribute") {
      const result = await attributeReferral(auth.user.hotelId!, typeof body.code === "string" ? body.code : "", customerId);
      if (!result.ok) return jsonError(result.reason ?? "Referral rejected.", 422, "REFERRAL_REJECTED");
      // Privacy: only the referrer display name is returned — never contacts.
      return Response.json({ attributed: true, referrerName: result.referrerName }, { status: 201 });
    }
    return jsonError("action must be 'code' or 'attribute'.", 422, "INVALID_ACTION");
  } catch (err) {
    return serverError(err);
  }
}

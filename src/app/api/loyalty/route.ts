import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { getLoyaltySettings, TIERS } from "@/lib/loyalty";
import { maskPhoneDisplay } from "@/lib/phone";

/**
 * Loyalty API — Phase 6.3
 * GET  /api/loyalty  — settings + program stats + member accounts (paginated)
 * PUT  /api/loyalty  — update program settings (audited)
 */

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "LOYALTY_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;

    const settings = await getLoyaltySettings(hotelId);

    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      50,
      Math.max(5, parseInt(url.searchParams.get("pageSize") || "10", 10) || 10),
    );
    const search = (url.searchParams.get("search") || "").trim();
    const tier = url.searchParams.get("tier") || "";

    const where: Record<string, unknown> = { hotelId };
    if (tier && TIERS.includes(tier as (typeof TIERS)[number])) where.tier = tier;
    if (search) {
      where.customer = {
        OR: [{ name: { contains: search } }, { phone: { contains: search } }],
      };
    }

    const [total, accounts, agg] = await Promise.all([
      db.loyaltyAccount.count({ where }),
      db.loyaltyAccount.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, phone: true, email: true, vip: true } },
        },
        orderBy: [{ points: "desc" }, { updatedAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.loyaltyAccount.aggregate({
        where: { hotelId },
        _count: { _all: true },
        _sum: { points: true, lifetimeSpend: true },
      }),
    ]);

    const tierCounts = await db.loyaltyAccount.groupBy({
      by: ["tier"],
      where: { hotelId },
      _count: { _all: true },
    });
    const tierMap: Record<string, number> = {};
    for (const t of tierCounts) tierMap[t.tier] = t._count._all;

    return Response.json({
      settings: {
        enabled: settings.enabled,
        mode: settings.mode,
        pointsPer100: settings.pointsPer100,
        pointsPerVisit: settings.pointsPerVisit,
        pointsForReward: settings.pointsForReward,
        rewardValue: settings.rewardValue,
        signupBonus: settings.signupBonus,
        silverTierSpend: settings.silverTierSpend,
        goldTierSpend: settings.goldTierSpend,
        vipTierSpend: settings.vipTierSpend,
      },
      stats: {
        members: agg._count._all,
        totalPointsOutstanding: agg._sum.points ?? 0,
        totalLifetimeSpend: agg._sum.lifetimeSpend ?? 0,
        tierCounts: tierMap,
      },
      accounts: accounts.map((a) => ({
        id: a.id,
        customerId: a.customerId,
        name: a.customer.name,
        phone: maskPhoneDisplay(a.customer.phone),
        vip: a.customer.vip,
        points: a.points,
        lifetimePoints: a.lifetimePoints,
        lifetimeSpend: a.lifetimeSpend,
        visitsCounted: a.visitsCounted,
        tier: a.tier,
        updatedAt: a.updatedAt.toISOString(),
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    return serverError(err, "Loyalty program data could not be loaded.");
  }
}

/** PUT /api/loyalty — update loyalty program rules. */
export async function PUT(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "LOYALTY_MANAGE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const settings = await getLoyaltySettings(hotelId);

    const intField = (v: unknown, min: number, max: number): number | null => {
      if (v === undefined || v === null || v === "") return null;
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < min || n > max) return null;
      return n;
    };
    const floatField = (v: unknown, min: number, max: number): number | null => {
      if (v === undefined || v === null || v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) return null;
      return n;
    };

    const mode =
      body.mode === "VISITS" || body.mode === "POINTS" ? (body.mode as "POINTS" | "VISITS") : null;
    const pointsPer100 = intField(body.pointsPer100, 0, 1000);
    const pointsPerVisit = intField(body.pointsPerVisit, 0, 10000);
    const pointsForReward = intField(body.pointsForReward, 1, 1_000_000);
    const rewardValue = floatField(body.rewardValue, 0, 1_000_000);
    const signupBonus = intField(body.signupBonus, 0, 10_000);
    const silverTierSpend = floatField(body.silverTierSpend, 0, 100_000_000);
    const goldTierSpend = floatField(body.goldTierSpend, 0, 100_000_000);
    const vipTierSpend = floatField(body.vipTierSpend, 0, 100_000_000);

    if (body.pointsPer100 !== undefined && body.pointsPer100 !== "" && pointsPer100 === null) {
      return jsonError("Points per ₹100 must be a whole number between 0 and 1000.");
    }
    if (
      body.pointsForReward !== undefined &&
      body.pointsForReward !== "" &&
      pointsForReward === null
    ) {
      return jsonError("Points needed for a reward must be between 1 and 1,000,000.");
    }
    if (silverTierSpend !== null && goldTierSpend !== null && silverTierSpend > goldTierSpend) {
      return jsonError("Silver tier spend must be less than or equal to Gold tier spend.");
    }
    if (goldTierSpend !== null && vipTierSpend !== null && goldTierSpend > vipTierSpend) {
      return jsonError("Gold tier spend must be less than or equal to VIP tier spend.");
    }

    const updated = await db.loyaltySettings.update({
      where: { hotelId },
      data: {
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(mode ? { mode } : {}),
        ...(pointsPer100 !== null ? { pointsPer100 } : {}),
        ...(pointsPerVisit !== null ? { pointsPerVisit } : {}),
        ...(pointsForReward !== null ? { pointsForReward } : {}),
        ...(rewardValue !== null ? { rewardValue } : {}),
        ...(signupBonus !== null ? { signupBonus } : {}),
        ...(silverTierSpend !== null ? { silverTierSpend } : {}),
        ...(goldTierSpend !== null ? { goldTierSpend } : {}),
        ...(vipTierSpend !== null ? { vipTierSpend } : {}),
      },
    });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.LOYALTY_SETTINGS_UPDATED,
      entityType: "loyalty_settings",
      entityId: updated.id,
      metadata: {
        mode: updated.mode,
        pointsPer100: updated.pointsPer100,
        pointsForReward: updated.pointsForReward,
        rewardValue: updated.rewardValue,
        enabled: updated.enabled,
      },
    });

    return Response.json({ ok: true });
  } catch (err) {
    return serverError(err, "Loyalty settings could not be updated.");
  }
}

import { db } from "@/lib/db";
import { enforceFeature } from "@/lib/saas/guards";
import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { funnelStats } from "@/lib/analytics";
import { providerStatus } from "@/lib/providers";
import { loadCustomerIntelligence, SYSTEM_SEGMENTS } from "@/lib/segments";

/** GET /api/analytics/overview — hotel-wide campaign performance + segment sizes. */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "ANALYTICS_READ");
    if (denied) return denied;

    // Phase 10 §11 — ANALYTICS entitlement enforced server-side.
    const featureBlocked = await enforceFeature(auth.user.hotelId, "ANALYTICS");
    if (featureBlocked) return featureBlocked;
    const { hotelId } = auth.user;

    const stats = await funnelStats({ hotelId });

    const campaigns = await db.campaign.findMany({
      where: { hotelId },
      select: { id: true, name: true, status: true },
      orderBy: { createdAt: "desc" },
    });

    const sentByCampaign = await db.campaignMessage.groupBy({
      by: ["campaignId"],
      where: { hotelId, status: { in: ["SENT", "SIMULATED"] } },
      _count: { _all: true },
    });
    const revenueByCampaign = await db.campaignMessage.groupBy({
      by: ["campaignId"],
      where: { hotelId, bookingLinked: true },
      _count: { _all: true },
      _sum: { bookingAmount: true },
    });

    const topCampaigns = campaigns
      .map((c) => {
        const sent = sentByCampaign.find((s) => s.campaignId === c.id)?._count._all ?? 0;
        const revenue =
          revenueByCampaign.find((r) => r.campaignId === c.id)?._sum.bookingAmount ?? 0;
        const bookings = revenueByCampaign.find((r) => r.campaignId === c.id)?._count._all ?? 0;
        return { id: c.id, name: c.name, status: c.status, sent, bookings, revenue };
      })
      .sort((a, b) => b.revenue - a.revenue || b.sent - a.sent)
      .slice(0, 8);

    // Segment sizes (live evaluation)
    const intel = await loadCustomerIntelligence(hotelId);
    const segmentSizes = SYSTEM_SEGMENTS.map((def) => {
      const count = intel.filter((c) => {
        // inline rule evaluation for the overview
        const rule = def.rule;
        const DAY = 24 * 60 * 60 * 1000;
        const now = new Date();
        switch (rule.kind) {
          case "new_customer":
            return c.totalVisits === 1;
          case "returning":
            return c.totalVisits >= 2;
          case "vip":
            return c.vip || c.totalSpend >= (rule.params?.minSpend ?? Infinity);
          case "inactive":
            return c.totalVisits > 0 && c.lastVisitAt !== null
              ? (now.getTime() - c.lastVisitAt.getTime()) / DAY >= (rule.params?.days ?? 90)
              : false;
          case "recent":
            if (!c.lastVisitAt) return false;
            return (
              (now.getTime() - c.lastVisitAt.getTime()) / DAY >= 7 &&
              (now.getTime() - c.lastVisitAt.getTime()) / DAY <= 30
            );
          case "weekend":
            return (
              c.totalVisits > 0 &&
              c.weekendStays / c.totalVisits >= (rule.params?.weekendRatio ?? 0.6)
            );
          case "high_value":
            return c.totalSpend >= (rule.params?.minSpend ?? Infinity);
          case "birthday":
          case "anniversary": {
            const date = rule.kind === "birthday" ? c.birthday : c.anniversary;
            if (!date) return false;
            const t = new Date(now);
            t.setHours(0, 0, 0, 0);
            const thisYear = new Date(t.getFullYear(), date.getMonth(), date.getDate());
            const target =
              thisYear.getTime() >= t.getTime()
                ? thisYear
                : new Date(t.getFullYear() + 1, date.getMonth(), date.getDate());
            return Math.round((target.getTime() - t.getTime()) / DAY) <= (rule.params?.days ?? 14);
          }
          default:
            return false;
        }
      }).length;
      return { name: def.name, color: def.color, count };
    });

    // Consent health
    const totalCustomers = intel.length;
    const optedIn = intel.filter((c) => c.marketingConsent && !c.optOut).length;
    const optedOut = intel.filter((c) => c.optOut).length;

    return Response.json({
      stats,
      providerMode: providerStatus(),
      topCampaigns,
      segmentSizes,
      consent: {
        totalCustomers,
        optedIn,
        optedOut,
        unreachable: totalCustomers - optedIn - optedOut,
      },
    });
  } catch (err) {
    return serverError(err, "Analytics could not be loaded. Please try again.");
  }
}

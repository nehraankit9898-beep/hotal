import { db } from "@/lib/db";
import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";

/**
 * GET /api/dashboard/stats — ALL numbers computed live from the database.
 * No hardcoded statistics.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "ANALYTICS_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;

    const [totalCustomers, marketingOptIn, optedOut, totalVisits, visitGroups] = await Promise.all([
      db.customer.count({ where: { hotelId, status: "ACTIVE" } }),
      db.customer.count({
        where: { hotelId, marketingConsent: true, optOut: false, status: "ACTIVE" },
      }),
      db.customer.count({ where: { hotelId, optOut: true } }),
      db.visit.count({ where: { hotelId } }),
      db.visit.groupBy({ by: ["customerId"], where: { hotelId }, _count: { _all: true } }),
    ]);

    const uniqueVisitors = visitGroups.length;
    const repeatCustomers = visitGroups.filter((g) => g._count._all >= 2).length;

    // Visits over the last 14 days (for trend chart)
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - 13);
    const recentVisits = await db.visit.findMany({
      where: { hotelId, checkin: { gte: since } },
      select: { checkin: true },
      orderBy: { checkin: "asc" },
    });
    const byDay = new Map<string, number>();
    for (let i = 0; i < 14; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      byDay.set(d.toISOString().slice(0, 10), 0);
    }
    for (const v of recentVisits) {
      const key = new Date(v.checkin).toISOString().slice(0, 10);
      if (byDay.has(key)) byDay.set(key, (byDay.get(key) || 0) + 1);
    }
    const visitsTrend = Array.from(byDay.entries()).map(([date, count]) => ({ date, count }));

    // Recent activity
    const [recentCustomers, recentVisitRows] = await Promise.all([
      db.customer.findMany({
        where: { hotelId },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, name: true, phone: true, createdAt: true, marketingConsent: true },
      }),
      db.visit.findMany({
        where: { hotelId },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          createdAt: true,
          checkin: true,
          customer: { select: { id: true, name: true } },
        },
      }),
    ]);

    // New customers vs repeat trend (last 6 weeks) — repeat potential
    const noConsent = Math.max(0, totalCustomers - marketingOptIn - optedOut);

    return Response.json({
      stats: {
        totalCustomers,
        marketingOptIn,
        optedOut,
        noConsent,
        totalVisits,
        uniqueVisitors,
        repeatCustomers,
        repeatRate: uniqueVisitors > 0 ? Math.round((repeatCustomers / uniqueVisitors) * 100) : 0,
      },
      visitsTrend,
      recentCustomers,
      recentVisits: recentVisitRows,
    });
  } catch (err) {
    return serverError(err, "Could not load dashboard statistics. Please refresh the page.");
  }
}

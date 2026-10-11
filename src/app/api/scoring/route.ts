import { db } from "@/lib/db";
import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { recomputeCustomerScores } from "@/lib/scoring";
import { maskPhoneDisplay } from "@/lib/phone";

/** GET /api/scoring — get top customers by lead score */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "LEAD_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const limit = Math.min(
      50,
      Math.max(5, parseInt(url.searchParams.get("limit") || "10", 10) || 10),
    );
    const tier = url.searchParams.get("tier"); // COLD | WARM | HOT | VERY_HOT

    const where: Record<string, unknown> = { hotelId: auth.user.hotelId };
    if (tier) where.leadTier = tier;

    const customers = await db.customer.findMany({
      where,
      select: {
        id: true,
        name: true,
        phone: true,
        customerValueScore: true,
        leadScore: true,
        leadTier: true,
        recencyScore: true,
        frequencyScore: true,
        monetaryScore: true,
        _count: { select: { visits: true } },
      },
      orderBy: { leadScore: "desc" },
      take: limit,
    });

    return Response.json({
      leaderboard: customers.map((c, idx) => ({
        rank: idx + 1,
        id: c.id,
        name: c.name,
        phone: maskPhoneDisplay(c.phone),
        score: c.customerValueScore,
        leadScore: c.leadScore,
        leadTier: c.leadTier ?? "COLD",
        rfm: {
          recency: c.recencyScore,
          frequency: c.frequencyScore,
          monetary: c.monetaryScore,
        },
        totalVisits: c._count.visits,
      })),
    });
  } catch (err) {
    return serverError(err, "Customer scores could not be loaded.");
  }
}

/** POST /api/scoring/recompute — recompute RFM scores for the entire hotel */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "LEAD_UPDATE");
    if (denied) return denied;

    const result = await recomputeCustomerScores(auth.user.hotelId);

    return Response.json(result);
  } catch (err) {
    return serverError(err, "Could not recompute customer scores.");
  }
}

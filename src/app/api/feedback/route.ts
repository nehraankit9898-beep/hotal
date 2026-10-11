import { db } from "@/lib/db";
import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { maskPhoneDisplay } from "@/lib/phone";

/** GET /api/feedback — customer feedback list + rating distribution. */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "FEEDBACK_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;

    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      50,
      Math.max(5, parseInt(url.searchParams.get("pageSize") || "15", 10) || 15),
    );
    const rating = parseInt(url.searchParams.get("rating") || "", 10);

    const where: Record<string, unknown> = { hotelId };
    if (rating >= 1 && rating <= 5) where.rating = rating;

    const [total, items, dist, avgAgg] = await Promise.all([
      db.feedback.count({ where }),
      db.feedback.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.feedback.groupBy({
        by: ["rating"],
        where: { hotelId },
        _count: { _all: true },
      }),
      db.feedback.aggregate({ where: { hotelId }, _avg: { rating: true }, _count: { _all: true } }),
    ]);

    const distribution: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    for (const d of dist) distribution[String(d.rating)] = d._count._all;

    return Response.json({
      feedback: items.map((f) => ({
        id: f.id,
        rating: f.rating,
        comment: f.comment,
        source: f.source,
        createdAt: f.createdAt.toISOString(),
        customer: f.customer
          ? { id: f.customer.id, name: f.customer.name, phone: maskPhoneDisplay(f.customer.phone) }
          : null,
      })),
      stats: {
        total: avgAgg._count._all,
        average: avgAgg._avg.rating ? Math.round(avgAgg._avg.rating * 10) / 10 : 0,
        distribution,
      },
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    return serverError(err, "Feedback could not be loaded.");
  }
}

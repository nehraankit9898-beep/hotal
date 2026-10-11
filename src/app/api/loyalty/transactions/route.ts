import { db } from "@/lib/db";
import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";

/** GET /api/loyalty/transactions?customerId=... — loyalty history for one member. */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "LOYALTY_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;

    const url = new URL(req.url);
    const customerId = url.searchParams.get("customerId") || "";
    if (!customerId) return jsonError("customerId is required.");

    const customer = await db.customer.findFirst({
      where: { id: customerId, hotelId },
      select: { id: true },
    });
    if (!customer) return jsonError("Customer not found in your hotel.", 404, "NOT_FOUND");

    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      50,
      Math.max(5, parseInt(url.searchParams.get("pageSize") || "15", 10) || 15),
    );

    const where = { hotelId, customerId };
    const [total, txns] = await Promise.all([
      db.loyaltyTransaction.count({ where }),
      db.loyaltyTransaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return Response.json({
      transactions: txns.map((t) => ({
        id: t.id,
        type: t.type,
        points: t.points,
        reason: t.reason,
        balanceAfter: t.balanceAfter,
        createdAt: t.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    return serverError(err, "Loyalty history could not be loaded.");
  }
}

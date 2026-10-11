import { db } from "@/lib/db";
import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";

/**
 * GET /api/visits — all visits for the hotel (newest first), with customer info.
 * Query: q (customer name/phone), from, to (dates), page, pageSize
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "VISIT_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;

    const url = new URL(req.url);
    const q = (url.searchParams.get("q") || "").trim();
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      50,
      Math.max(5, parseInt(url.searchParams.get("pageSize") || "10", 10) || 10),
    );

    const where: Record<string, unknown> = { hotelId };
    if (q) {
      where.OR = [
        { customer: { name: { contains: q } } },
        { customer: { phone: { contains: q.replace(/[\s\-()+]/g, "") } } },
      ];
    }
    if (from || to) {
      const checkinFilter: { gte?: Date; lte?: Date } = {};
      if (from && !isNaN(new Date(from).getTime())) checkinFilter.gte = new Date(from);
      if (to && !isNaN(new Date(to).getTime())) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        checkinFilter.lte = end;
      }
      where.checkin = checkinFilter;
    }

    const total = await db.visit.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const visits = await db.visit.findMany({
      where,
      orderBy: { checkin: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        customer: { select: { id: true, name: true, phone: true } },
      },
    });

    return Response.json({
      visits: visits.map((v) => ({
        id: v.id,
        customerId: v.customerId,
        customerName: v.customer.name,
        customerPhone: v.customer.phone,
        checkin: v.checkin,
        checkout: v.checkout,
        source: v.source,
        notes: v.notes,
        createdAt: v.createdAt,
      })),
      total,
      page,
      pageSize,
      totalPages,
    });
  } catch (err) {
    return serverError(err, "Could not load visits. Please try again.");
  }
}

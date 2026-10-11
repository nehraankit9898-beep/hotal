import { NextResponse } from "next/server";
import { serverError, requireSuperAdminSession } from "@/lib/api-helpers";
import { db } from "@/lib/db";

/**
 * Subscriptions list — Phase 10 §5 (Super Admin only).
 * GET /api/super-admin/subscriptions?status=&q=&page=
 */
export async function GET(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const url = new URL(req.url);
    const status = url.searchParams.get("status") || "";
    const q = (url.searchParams.get("q") || "").trim();
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(5, parseInt(url.searchParams.get("pageSize") || "25", 10) || 25),
    );

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (q) where.hotel = { OR: [{ name: { contains: q } }, { tenantId: { contains: q } }] };

    const [total, rows] = await Promise.all([
      db.subscription.count({ where }),
      db.subscription.findMany({
        where,
        include: {
          hotel: { select: { id: true, name: true, tenantId: true, status: true } },
          plan: {
            select: {
              id: true,
              key: true,
              name: true,
              monthlyPrice: true,
              yearlyPrice: true,
              currency: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return NextResponse.json({
      subscriptions: rows.map((s) => ({
        id: s.id,
        hotelId: s.hotelId,
        hotelName: s.hotel?.name ?? "",
        tenantId: s.hotel?.tenantId ?? "",
        hotelStatus: s.hotel?.status ?? "",
        plan: s.plan,
        status: s.status,
        billingCycle: s.billingCycle,
        amount: s.amount,
        currency: s.currency,
        startedAt: s.startedAt.toISOString(),
        trialStartsAt: s.trialStartsAt?.toISOString() ?? null,
        trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
        graceEndsAt: s.graceEndsAt?.toISOString() ?? null,
        currentPeriodStart: s.currentPeriodStart?.toISOString() ?? null,
        currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
        nextInvoiceAt: s.nextInvoiceAt?.toISOString() ?? null,
        cancelledAt: s.cancelledAt?.toISOString() ?? null,
        expiredAt: s.expiredAt?.toISOString() ?? null,
        provider: s.provider,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    return serverError(err, "Could not load subscriptions.");
  }
}

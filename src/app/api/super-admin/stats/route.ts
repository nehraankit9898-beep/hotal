import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSuperAdminSession } from "@/lib/api-helpers";
import { getPlatformStats, ensurePlansSeed } from "@/lib/super-admin";

/** GET /api/super-admin/stats — platform-wide KPIs (Super Admin only). */
export async function GET(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    await ensurePlansSeed();

    const stats = await getPlatformStats();

    // Hotels breakdown
    const hotels = await db.hotel.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        plan: true,
        _count: {
          select: {
            customers: true,
            users: true,
            campaigns: true,
            visits: true,
            restaurantVisits: true,
          },
        },
      },
      take: 50,
    });

    return Response.json({
      stats,
      hotels: hotels.map((h) => ({
        id: h.id,
        name: h.name,
        city: h.city,
        plan: h.plan?.name ?? null,
        customers: h._count.customers,
        staff: h._count.users,
        campaigns: h._count.campaigns,
        status: h.status,
        createdAt: h.createdAt.toISOString(),
        lastActivity: h.updatedAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error("[super-admin/stats] error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not load platform stats." } },
      { status: 500 },
    );
  }
}

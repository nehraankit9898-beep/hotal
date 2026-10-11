import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { requireSuperAdminSession } from "@/lib/api-helpers";
import { getUsageSummary } from "@/lib/saas/limits";

/**
 * GET /api/super-admin/usage?id=<hotelId> — Phase 10 §12 (Super Admin only).
 *   With id: full resource summary for ONE hotel.
 *   Without id: platform-wide usage summary for every hotel.
 */
export async function GET(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;

  try {
    const url = new URL(req.url);
    const hotelId = url.searchParams.get("id");

    interface UsageRow {
      hotelId: string;
      hotelName: string;
      period: string;
      plan: { id: string; key: string; name: string } | null;
      resources: {
        resource: string;
        used: number;
        limit: number;
        allowed: boolean;
        remaining: number | null;
        percent: number;
      }[];
    }
    const summarize = async (hotel: { id: string; name: string }): Promise<UsageRow> => {
      const summary = await getUsageSummary(hotel.id);
      return {
        hotelId: hotel.id,
        hotelName: hotel.name,
        period: summary.period,
        plan: summary.plan,
        resources: summary.resources,
      };
    };

    if (hotelId) {
      const hotel = await db.hotel.findUnique({ where: { id: hotelId } });
      if (!hotel)
        return NextResponse.json(
          { error: { code: "NOT_FOUND", message: "Hotel not found." } },
          { status: 404 },
        );
      const usage = await summarize(hotel);
      return NextResponse.json({ usage: [usage] });
    }

    // Platform-wide: every hotel's live usage snapshot (top 100 by name).
    const hotels = await db.hotel.findMany({
      orderBy: { name: "asc" },
      take: 100,
      select: { id: true, name: true },
    });
    const usage: UsageRow[] = [];
    for (const hotel of hotels) {
      usage.push(await summarize(hotel));
    }
    return NextResponse.json({ usage });
  } catch (err) {
    console.error("[super-admin/usage] error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not load usage." } },
      { status: 500 },
    );
  }
}

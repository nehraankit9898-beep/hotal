import { db } from "@/lib/db";
import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { funnelStats } from "@/lib/analytics";
import { providerStatus } from "@/lib/providers";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/campaigns/[id]/analytics — full funnel for one campaign. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_READ");
    if (denied) return denied;
    const { id } = await ctx.params;

    const campaign = await db.campaign.findFirst({ where: { id, hotelId: auth.user.hotelId } });
    if (!campaign) return jsonError("Campaign not found in your hotel.", 404, "NOT_FOUND");

    const stats = await funnelStats({ hotelId: auth.user.hotelId, campaignId: id });

    const byChannel = await db.campaignMessage.groupBy({
      by: ["channel", "status"],
      where: { campaignId: id, hotelId: auth.user.hotelId },
      _count: { _all: true },
    });

    const timeline = await db.campaignMessage.findMany({
      where: { campaignId: id, hotelId: auth.user.hotelId, status: { in: ["SENT", "SIMULATED"] } },
      select: { sentAt: true },
      orderBy: { sentAt: "asc" },
    });

    // Sends per day
    const perDay = new Map<string, number>();
    for (const m of timeline) {
      if (!m.sentAt) continue;
      const key = m.sentAt.toISOString().slice(0, 10);
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }

    return Response.json({
      campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
      stats,
      providerMode: providerStatus(),
      byChannel: byChannel.map((g) => ({
        channel: g.channel,
        status: g.status,
        count: g._count._all,
      })),
      sendsPerDay: [...perDay.entries()]
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    });
  } catch (err) {
    return serverError(err, "Campaign analytics could not be loaded. Please try again.");
  }
}

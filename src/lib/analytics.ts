import { db } from "@/lib/db";

/**
 * Campaign analytics — Phase 2
 * All figures are computed from real CampaignMessage rows.
 * - sent/delivered/opened/clicked come from the send pipeline + provider webhooks
 * - bookings/revenue come from booking attribution (manual record or webhook)
 * - ROI = attributed revenue / estimated messaging cost (costPerMessage is a
 *   business input, default ₹0.50 — clearly labelled in the UI)
 */

export const DEFAULT_COST_PER_MESSAGE = 0.5;

export interface FunnelStats {
  total: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  failed: number;
  skipped: number;
  bookings: number;
  revenue: number;
  estimatedCost: number;
  roi: number | null; // null when no cost yet
  openRate: number | null;
  clickRate: number | null;
  deliveryRate: number | null;
}

export async function funnelStats(where: {
  hotelId: string;
  campaignId?: string;
}): Promise<FunnelStats> {
  const messages = await db.campaignMessage.findMany({
    where: where.campaignId
      ? { hotelId: where.hotelId, campaignId: where.campaignId }
      : { hotelId: where.hotelId },
    select: {
      status: true,
      sentAt: true,
      deliveredAt: true,
      openedAt: true,
      clickedAt: true,
      bookingLinked: true,
      bookingAmount: true,
    },
  });

  // Phase 6.4: simulation-mode deliveries are processed end-to-end, so they
  // count toward funnel analytics; the per-message status stays honest
  // (SIMULATED at row level — never shown to admins as a real provider send).
  const sent = messages.filter((m) => m.status === "SENT" || m.status === "SIMULATED").length;
  const delivered = messages.filter((m) => m.deliveredAt !== null).length;
  const opened = messages.filter((m) => m.openedAt !== null).length;
  const clicked = messages.filter((m) => m.clickedAt !== null).length;
  const failed = messages.filter((m) => m.status === "FAILED").length;
  const skipped = messages.filter((m) => m.status === "SKIPPED").length;
  const bookings = messages.filter((m) => m.bookingLinked);
  const revenue = bookings.reduce((s, m) => s + (m.bookingAmount ?? 0), 0);

  // NOTE: `||` (not `??`) — an EMPTY string from .env (COST_PER_MESSAGE=) must
  // fall back to the default, not become 0 (Phase 10 bug fix).
  const costPerMessage = Number(process.env.COST_PER_MESSAGE || DEFAULT_COST_PER_MESSAGE) || 0;
  const estimatedCost = sent * costPerMessage;

  return {
    total: messages.length,
    sent,
    delivered,
    opened,
    clicked,
    failed,
    skipped,
    bookings: bookings.length,
    revenue,
    estimatedCost,
    roi: estimatedCost > 0 ? revenue / estimatedCost : null,
    openRate: sent > 0 ? opened / sent : null,
    clickRate: sent > 0 ? clicked / sent : null,
    deliveryRate: sent > 0 ? delivered / sent : null,
  };
}

export interface CampaignListRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  scheduleType: string;
  scheduledAt: string | null;
  channels: string[];
  offer: string | null;
  audienceSegment: { id: string; name: string; type: string } | null;
  automated: boolean;
  lastSentAt: string | null;
  createdAt: string;
  audienceSize: number;
  stats: {
    sent: number;
    skipped: number;
    failed: number;
    clicked: number;
    bookings: number;
    revenue: number;
  };
}

/** Campaign list with per-campaign quick stats. */
export async function campaignList(hotelId: string): Promise<CampaignListRow[]> {
  const campaigns = await db.campaign.findMany({
    where: { hotelId },
    include: { segment: true },
    orderBy: { createdAt: "desc" },
  });

  const grouped = await db.campaignMessage.groupBy({
    by: ["campaignId", "status"],
    where: { hotelId },
    _count: { _all: true },
  });
  const bookingAgg = await db.campaignMessage.groupBy({
    by: ["campaignId"],
    where: { hotelId, bookingLinked: true },
    _count: { _all: true },
    _sum: { bookingAmount: true },
  });
  const clickedAgg = await db.campaignMessage.groupBy({
    by: ["campaignId"],
    where: { hotelId, clickedAt: { not: null } },
    _count: { _all: true },
  });
  const memberAgg = await db.segmentMember.groupBy({
    by: ["segmentId"],
    where: {
      segmentId: { in: campaigns.map((c) => c.segmentId).filter((x): x is string => Boolean(x)) },
    },
    _count: { _all: true },
  });

  return campaigns.map((c) => {
    const statFor = (status: string) =>
      grouped.find((g) => g.campaignId === c.id && g.status === status)?._count._all ?? 0;
    const bookings = bookingAgg.find((b) => b.campaignId === c.id);
    const audienceSize = c.segmentId
      ? (memberAgg.find((m) => m.segmentId === c.segmentId)?._count._all ?? 0)
      : 0;
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      status: c.status,
      scheduleType: c.scheduleType,
      scheduledAt: c.scheduledAt?.toISOString() ?? null,
      channels: safeParseChannels(c.channels),
      offer: c.offer,
      audienceSegment: c.segment
        ? { id: c.segment.id, name: c.segment.name, type: c.segment.type }
        : null,
      automated: c.scheduleType === "AUTOMATED",
      lastSentAt: c.lastSentAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
      audienceSize,
      stats: {
        sent: statFor("SENT"),
        skipped: statFor("SKIPPED"),
        failed: statFor("FAILED"),
        clicked: clickedAgg.find((x) => x.campaignId === c.id)?._count._all ?? 0,
        bookings: bookings?._count._all ?? 0,
        revenue: bookings?._sum.bookingAmount ?? 0,
      },
    };
  });
}

function safeParseChannels(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

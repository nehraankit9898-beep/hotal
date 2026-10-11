import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import type { LeadEventType } from "@prisma/client";

/**
 * Lead Scoring — Phase 4
 *
 * Assigns each customer a 0-100 score based on engagement signals.
 * When a customer passes a tier threshold (Cold → Warm → Hot → Very Hot),
 * the engine emits a notification and records the change on the customer.
 *
 * Signals (real, attribution from real events):
 *   MESSAGE_OPENED       +5
 *   LINK_CLICKED        +10
 *   OFFER_VIEWED        +10
 *   REPLIED             +20
 *   BOOKING_PAGE_VISITED +15
 *   BOOKING_COMPLETED   +50
 *   COUPON_REDEEMED     +30
 *
 * Score is recomputed as the sum of signals in the trailing 90-day window,
 * capped at 100. This is deterministic from real DB events — never fabricated.
 */

const SCORE_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export const LEAD_SIGNAL_POINTS: Record<string, number> = {
  MESSAGE_OPENED: 5,
  LINK_CLICKED: 10,
  OFFER_VIEWED: 10,
  REPLIED: 20,
  BOOKING_PAGE_VISITED: 15,
  BOOKING_COMPLETED: 50,
  COUPON_REDEEMED: 30,
};

export const TIER_THRESHOLDS = {
  COLD: 0,
  WARM: 31,
  HOT: 61,
  VERY_HOT: 81,
};

export function tierForScore(score: number): "COLD" | "WARM" | "HOT" | "VERY_HOT" {
  if (score >= TIER_THRESHOLDS.VERY_HOT) return "VERY_HOT";
  if (score >= TIER_THRESHOLDS.HOT) return "HOT";
  if (score >= TIER_THRESHOLDS.WARM) return "WARM";
  return "COLD";
}

export const TIER_LABELS: Record<string, string> = {
  COLD: "Cold",
  WARM: "Warm",
  HOT: "Hot",
  VERY_HOT: "Very Hot",
};

export const TIER_COLORS: Record<string, string> = {
  COLD: "slate",
  WARM: "sky",
  HOT: "amber",
  VERY_HOT: "rose",
};

/**
 * Record a lead event and update the customer's score + tier.
 * Idempotent on (customer, type, messageId) — re-emitting the same opened
 * event will not inflate the score. Enforced by the
 * @@unique([customerId, type, messageId]) database constraint (Phase 14) so
 * concurrent webhook deliveries cannot create duplicates; the loser of a
 * race is treated as a duplicate (0 points).
 */
export async function recordLeadEvent(params: {
  hotelId: string;
  customerId: string;
  type: keyof typeof LEAD_SIGNAL_POINTS;
  campaignId?: string;
  messageId?: string;
  userId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<{
  points: number;
  newScore: number;
  newTier: string;
  promoted: boolean;
  duplicate: boolean;
}> {
  const points = LEAD_SIGNAL_POINTS[params.type] ?? 0;

  let created: { id: string } | null = null;
  try {
    created = await db.leadEvent.create({
      data: {
        hotelId: params.hotelId,
        customerId: params.customerId,
        campaignId: params.campaignId ?? null,
        messageId: params.messageId ?? null,
        userId: params.userId ?? null,
        type: params.type as LeadEventType,
        points,
        metadata: params.metadata ? JSON.stringify(params.metadata) : null,
      },
      select: { id: true },
    });
  } catch (err) {
    // P2002 = unique-constraint violation: exact same event already exists.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      const existing = await recomputeLeadScore(params.customerId, params.hotelId);
      return {
        points: 0,
        newScore: existing.newScore,
        newTier: existing.newTier,
        promoted: false,
        duplicate: true,
      };
    }
    throw err;
  }
  void created;

  const { newScore, newTier, promoted } = await recomputeLeadScore(
    params.customerId,
    params.hotelId,
  );

  // When a customer crosses into Hot/Very Hot, emit a notification.
  if (promoted && (newTier === "HOT" || newTier === "VERY_HOT")) {
    const customer = await db.customer.findUnique({
      where: { id: params.customerId },
      select: { name: true },
    });
    await db.notification.create({
      data: {
        hotelId: params.hotelId,
        level: newTier === "VERY_HOT" ? "CRITICAL" : "WARNING",
        title: `🔥 Lead promoted to ${TIER_LABELS[newTier]}`,
        message: `${customer?.name ?? "A customer"} is now ${TIER_LABELS[newTier]} — contact them soon.`,
        metadata: JSON.stringify({ customerId: params.customerId, tier: newTier, score: newScore }),
      },
    });

    await logAudit({
      hotelId: params.hotelId,
      userId: params.userId ?? null,
      action: "LEAD_PROMOTED",
      entityType: "customer",
      entityId: params.customerId,
      metadata: { tier: newTier, score: newScore },
    });
  }

  return { points, newScore, newTier, promoted, duplicate: false };
}

/** Recompute a customer's lead score from events in the trailing window. */
export async function recomputeLeadScore(
  customerId: string,
  hotelId: string,
): Promise<{
  newScore: number;
  newTier: "COLD" | "WARM" | "HOT" | "VERY_HOT";
  promoted: boolean;
  previousTier: string;
}> {
  const cutoff = new Date(Date.now() - SCORE_WINDOW_DAYS * DAY_MS);
  const events = await db.leadEvent.findMany({
    where: { customerId, createdAt: { gte: cutoff } },
    select: { points: true },
  });
  const sum = events.reduce((s, e) => s + e.points, 0);
  const newScore = Math.min(100, sum);
  const newTier = tierForScore(newScore);

  const customer = await db.customer.findUnique({
    where: { id: customerId },
    select: { leadScore: true, leadTier: true },
  });
  const previousTier = customer?.leadTier ?? "COLD";
  const promoted = previousTier !== newTier;

  await db.customer.update({
    where: { id: customerId },
    data: { leadScore: newScore, leadTier: newTier },
  });

  return { newScore, newTier, promoted, previousTier };
}

/** Convenience: hook into campaign message events.
 *  Phase 7: hotelId is ALWAYS derived from the stored message record —
 *  webhook callers cannot influence tenant context. */
export async function onCampaignMessageOpened(messageId: string): Promise<void> {
  const msg = await db.campaignMessage.findUnique({
    where: { id: messageId },
    select: { customerId: true, campaignId: true, hotelId: true },
  });
  if (!msg) return;
  // First-write-wins: repeated deliveries never overwrite the first timestamp.
  await db.campaignMessage.updateMany({
    where: { id: messageId, openedAt: null },
    data: { openedAt: new Date() },
  });
  await recordLeadEvent({
    hotelId: msg.hotelId,
    customerId: msg.customerId,
    type: "MESSAGE_OPENED",
    campaignId: msg.campaignId ?? undefined,
    messageId,
  });
}

export async function onCampaignMessageClicked(messageId: string): Promise<void> {
  const msg = await db.campaignMessage.findUnique({
    where: { id: messageId },
    select: { customerId: true, campaignId: true, hotelId: true },
  });
  if (!msg) return;
  await db.campaignMessage.updateMany({
    where: { id: messageId, clickedAt: null },
    data: { clickedAt: new Date() },
  });
  await recordLeadEvent({
    hotelId: msg.hotelId,
    customerId: msg.customerId,
    type: "LINK_CLICKED",
    campaignId: msg.campaignId ?? undefined,
    messageId,
  });
}

export async function onCampaignMessageReplied(messageId: string, reply: string): Promise<void> {
  const msg = await db.campaignMessage.findUnique({
    where: { id: messageId },
    select: { customerId: true, campaignId: true, hotelId: true },
  });
  if (!msg) return;
  await db.campaignMessage.updateMany({
    where: { id: messageId, repliedAt: null },
    data: { repliedAt: new Date() },
  });
  await recordLeadEvent({
    hotelId: msg.hotelId,
    customerId: msg.customerId,
    type: "REPLIED",
    campaignId: msg.campaignId ?? undefined,
    messageId,
    metadata: { replyPreview: reply.slice(0, 200) },
  });
}

/**
 * Smart send-time recommendation — Phase 4
 * Returns the suggested send time today for a customer based on when they
 * typically open messages. Falls back to "now" if no historical data.
 */
export async function recommendedSendTime(
  customerId: string,
  hotelId: string,
): Promise<{
  suggestedHour: number;
  confidence: "low" | "medium" | "high";
  basis: string;
}> {
  const opens = await db.leadEvent.findMany({
    where: { customerId, type: "MESSAGE_OPENED" },
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  if (opens.length === 0) {
    return { suggestedHour: 19, confidence: "low", basis: "No open history — using default 7 PM." };
  }

  const hourCounts = new Array(24).fill(0);
  for (const o of opens) {
    const h = new Date(o.createdAt).getHours();
    hourCounts[h] += 1;
  }
  let best = 19,
    bestCount = 0;
  for (let h = 0; h < 24; h++) {
    if (hourCounts[h] > bestCount) {
      best = h;
      bestCount = hourCounts[h];
    }
  }
  const confidence = opens.length >= 10 ? "high" : opens.length >= 3 ? "medium" : "low";
  return {
    suggestedHour: best,
    confidence,
    basis: `${bestCount} of ${opens.length} recent opens occurred around ${best}:00.`,
  };
}

/** Compute the lead score for a customer directly (for reporting). */
export async function computeLeadScore(customerId: string, hotelId: string): Promise<number> {
  const cutoff = new Date(Date.now() - SCORE_WINDOW_DAYS * DAY_MS);
  const events = await db.leadEvent.findMany({
    where: { customerId, hotelId, createdAt: { gte: cutoff } },
    select: { points: true },
  });
  return Math.min(
    100,
    events.reduce((s, e) => s + e.points, 0),
  );
}

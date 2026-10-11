import { db } from "@/lib/db";

/**
 * Customer Scoring — Phase 3
 *
 * RFM (Recency/Frequency/Monetary) scoring + composite value score.
 * Recency: days since last visit (lower = better)
 * Frequency: total visits (higher = better)
 * Monetary: total spending (higher = better)
 *
 * Each axis is scored 1-5 using quintile-like binning against the hotel's own
 * customer base (no cross-hotel leakage).
 */

export interface RfmInput {
  customerId: string;
  recencyDays: number | null; // null when no visits yet
  frequency: number;
  monetary: number;
}

export interface RfmScored extends RfmInput {
  recencyScore: number; // 1-5
  frequencyScore: number; // 1-5
  monetaryScore: number; // 1-5
  customerValueScore: number; // weighted (0-100)
}

const DAY_MS = 24 * 60 * 60 * 1000;

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

/** Score one axis using quintile thresholds. Returns 1..5 (higher = better). */
function quintileScore(value: number, asc: number[]): number {
  if (asc.length === 0) return 1;
  if (value <= percentile(asc, 20)) return 1;
  if (value <= percentile(asc, 40)) return 2;
  if (value <= percentile(asc, 60)) return 3;
  if (value <= percentile(asc, 80)) return 4;
  return 5;
}

/** For recency: LOWER is better, so we invert the binning direction. */
function quintileScoreInverse(value: number | null, asc: number[]): number {
  if (value === null) return 1;
  if (asc.length === 0) return 1;
  // Highest recency days = worst. Lowest = best.
  if (value >= percentile(asc, 80)) return 1;
  if (value >= percentile(asc, 60)) return 2;
  if (value >= percentile(asc, 40)) return 3;
  if (value >= percentile(asc, 20)) return 4;
  return 5;
}

/**
 * Compute RFM scores for every customer in a hotel and persist them.
 * Returns a summary so the caller can show stats in the dashboard.
 */
export async function recomputeCustomerScores(hotelId: string): Promise<{
  processed: number;
  topScorers: { id: string; name: string; score: number; tier: string }[];
}> {
  const customers = await db.customer.findMany({
    where: { hotelId },
    select: {
      id: true,
      name: true,
      visits: {
        select: { checkin: true, checkout: true, amount: true },
        orderBy: { checkin: "asc" },
      },
    },
  });

  const now = Date.now();
  const inputs: RfmInput[] = customers.map((c) => {
    const visits = c.visits;
    const totalSpend = visits.reduce((s, v) => s + (v.amount ?? 0), 0);
    const lastVisit = visits.length ? visits[visits.length - 1].checkin : null;
    const recencyDays = lastVisit ? Math.floor((now - lastVisit.getTime()) / DAY_MS) : null;
    return {
      customerId: c.id,
      recencyDays,
      frequency: visits.length,
      monetary: totalSpend,
    };
  });

  if (inputs.length === 0) return { processed: 0, topScorers: [] };

  const recencySorted = inputs
    .map((i) => i.recencyDays ?? Number.MAX_SAFE_INTEGER)
    .sort((a, b) => a - b);
  const frequencySorted = inputs.map((i) => i.frequency).sort((a, b) => a - b);
  const monetarySorted = inputs.map((i) => i.monetary).sort((a, b) => a - b);

  const scored: RfmScored[] = inputs.map((i) => {
    const r = quintileScoreInverse(i.recencyDays, recencySorted);
    const f = quintileScore(i.frequency, frequencySorted);
    const m = quintileScore(i.monetary, monetarySorted);
    // Weighted: Recency 35%, Frequency 25%, Monetary 40% (industry-typical for hotels)
    const value = Math.round((r * 0.35 + f * 0.25 + m * 0.4) * 20); // 0-100
    return {
      ...i,
      recencyScore: r,
      frequencyScore: f,
      monetaryScore: m,
      customerValueScore: value,
    };
  });

  // Persist
  await db.$transaction(
    scored.map((s) =>
      db.customer.update({
        where: { id: s.customerId },
        data: {
          recencyScore: s.recencyScore,
          frequencyScore: s.frequencyScore,
          monetaryScore: s.monetaryScore,
          customerValueScore: s.customerValueScore,
        },
      }),
    ),
  );

  const topScorers = scored
    .map((s) => {
      const tier = tierForScore(s.customerValueScore);
      const customer = customers.find((c) => c.id === s.customerId)!;
      return { id: s.customerId, name: customer.name, score: s.customerValueScore, tier };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return { processed: scored.length, topScorers };
}

export function tierForScore(score: number): string {
  if (score >= 81) return "VERY_HOT";
  if (score >= 61) return "HOT";
  if (score >= 31) return "WARM";
  return "COLD";
}

export const TIER_LABELS: Record<string, string> = {
  COLD: "Cold",
  WARM: "Warm",
  HOT: "Hot",
  VERY_HOT: "Very Hot",
};

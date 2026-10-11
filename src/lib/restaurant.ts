import { db } from "@/lib/db";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { awardForRestaurantVisit } from "@/lib/loyalty";

/**
 * Restaurant Customer Growth Engine — Phase 5
 *
 * A "restaurant customer" is a Customer row whose source or visit history
 * is dominated by restaurant visits rather than room bookings. This module
 * manages restaurant-specific visits, orders, segments and lifecycle.
 *
 * Important: same consent gates apply. No marketing to opted-out customers.
 */

export const RESTAURANT_SEGMENT_DEFS = [
  {
    name: "First-Time Diner",
    description: "Exactly one restaurant visit so far.",
    rule: { kind: "first_time_diner" },
    color: "sky",
  },
  {
    name: "Returning Diner",
    description: "Two or more restaurant visits.",
    rule: { kind: "returning_diner" },
    color: "emerald",
  },
  {
    name: "VIP Diner",
    description: "Lifetime restaurant spending ≥ ₹25,000.",
    rule: { kind: "vip_diner", params: { minSpend: 25000 } },
    color: "amber",
  },
  {
    name: "Inactive Diner",
    description: "No restaurant visit in the last 60 days.",
    rule: { kind: "inactive_diner", params: { days: 60 } },
    color: "rose",
  },
  {
    name: "Weekend Diner",
    description: "Majority of restaurant visits on Fri/Sat/Sun.",
    rule: { kind: "weekend_diner", params: { ratio: 0.6 } },
    color: "orange",
  },
  {
    name: "Family Diner",
    description: "Average guests per visit ≥ 3.",
    rule: { kind: "family_diner", params: { minGuests: 3 } },
    color: "violet",
  },
  {
    name: "Frequent Diner",
    description: "Five or more restaurant visits.",
    rule: { kind: "frequent_diner", params: { minVisits: 5 } },
    color: "lime",
  },
  {
    name: "High Spender",
    description: "Average order ≥ ₹1,500.",
    rule: { kind: "high_spender", params: { minAvg: 1500 } },
    color: "teal",
  },
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RestaurantCustomerIntelligence {
  id: string;
  name: string;
  phone: string;
  marketingConsent: boolean;
  optOut: boolean;
  totalRestaurantVisits: number;
  totalRestaurantSpend: number;
  avgOrderValue: number;
  lastRestaurantVisit: Date | null;
  firstRestaurantVisit: Date | null;
  weekendVisits: number;
  avgGuests: number;
  favouriteCategory: string | null;
}

export async function loadRestaurantIntelligence(
  hotelId: string,
): Promise<RestaurantCustomerIntelligence[]> {
  const customers = await db.customer.findMany({
    where: { hotelId, restaurantVisits: { some: {} } },
    select: {
      id: true,
      name: true,
      phone: true,
      marketingConsent: true,
      optOut: true,
      restaurantVisits: {
        select: { visitDate: true, orderAmount: true, guests: true, foodCategory: true },
        orderBy: { visitDate: "asc" },
      },
    },
  });
  return customers.map((c) => {
    const visits = c.restaurantVisits;
    const total = visits.reduce((s, v) => s + (v.orderAmount ?? 0), 0);
    const weekendVisits = visits.filter((v) => {
      const day = new Date(v.visitDate).getDay();
      return day === 5 || day === 6 || day === 0;
    }).length;
    const avgGuests = visits.length
      ? visits.reduce((s, v) => s + (v.guests ?? 1), 0) / visits.length
      : 0;
    const categoryCounts = new Map<string, number>();
    for (const v of visits) {
      if (v.foodCategory)
        categoryCounts.set(v.foodCategory, (categoryCounts.get(v.foodCategory) ?? 0) + 1);
    }
    const favouriteCategory =
      [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      marketingConsent: c.marketingConsent,
      optOut: c.optOut,
      totalRestaurantVisits: visits.length,
      totalRestaurantSpend: total,
      avgOrderValue: visits.length ? total / visits.length : 0,
      lastRestaurantVisit: visits.length ? visits[visits.length - 1].visitDate : null,
      firstRestaurantVisit: visits.length ? visits[0].visitDate : null,
      weekendVisits,
      avgGuests,
      favouriteCategory,
    };
  });
}

/** Rule shape stored on restaurant auto-segments (JSON in Segment.rule). */
export interface RestaurantSegmentRule {
  kind:
    | "first_time_diner"
    | "returning_diner"
    | "vip_diner"
    | "inactive_diner"
    | "weekend_diner"
    | "family_diner"
    | "frequent_diner"
    | "high_spender";
  params?: {
    minSpend?: number;
    days?: number;
    ratio?: number;
    minGuests?: number;
    minVisits?: number;
    minAvg?: number;
  };
}

function matchesRule(
  c: RestaurantCustomerIntelligence,
  rule: RestaurantSegmentRule,
  now = new Date(),
): boolean {
  const p = rule.params ?? {};
  switch (rule.kind) {
    case "first_time_diner":
      return c.totalRestaurantVisits === 1;
    case "returning_diner":
      return c.totalRestaurantVisits >= 2;
    case "vip_diner":
      return p.minSpend !== undefined && c.totalRestaurantSpend >= p.minSpend;
    case "inactive_diner": {
      if (!c.lastRestaurantVisit) return false;
      const days = p.days ?? 60;
      return (now.getTime() - c.lastRestaurantVisit.getTime()) / DAY_MS >= days;
    }
    case "weekend_diner":
      return (
        c.totalRestaurantVisits > 0 && c.weekendVisits / c.totalRestaurantVisits >= (p.ratio ?? 0.6)
      );
    case "family_diner":
      return c.avgGuests >= (p.minGuests ?? 3);
    case "frequent_diner":
      return c.totalRestaurantVisits >= (p.minVisits ?? 5);
    case "high_spender":
      return c.avgOrderValue >= (p.minAvg ?? 1500);
    default:
      return false;
  }
}

export async function ensureRestaurantSegments(hotelId: string) {
  const existing = await db.segment.findMany({
    where: { hotelId, domain: "RESTAURANT", isSystem: true },
  });
  const byName = new Map(existing.map((s) => [s.name, s]));
  for (const def of RESTAURANT_SEGMENT_DEFS) {
    if (!byName.has(def.name)) {
      await db.segment.create({
        data: {
          hotelId,
          name: def.name,
          description: def.description,
          type: "AUTO",
          rule: JSON.stringify(def.rule),
          isSystem: true,
          color: def.color,
          domain: "RESTAURANT",
        },
      });
    }
  }
  return db.segment.findMany({
    where: { hotelId, domain: "RESTAURANT", isSystem: true },
    orderBy: { name: "asc" },
  });
}

export async function refreshRestaurantSegments(hotelId: string, now = new Date()) {
  await ensureRestaurantSegments(hotelId);
  const segments = await db.segment.findMany({
    where: { hotelId, domain: "RESTAURANT", type: "AUTO" },
  });
  const customers = await loadRestaurantIntelligence(hotelId);
  for (const segment of segments) {
    let rule: RestaurantSegmentRule | null = null;
    try {
      rule = JSON.parse(segment.rule ?? "{}") as RestaurantSegmentRule;
    } catch {
      continue;
    }
    if (!rule || typeof rule.kind !== "string") continue;
    const memberIds = customers.filter((c) => matchesRule(c, rule, now)).map((c) => c.id);
    await db.$transaction(async (tx) => {
      await tx.segmentMember.deleteMany({ where: { segmentId: segment.id, source: "AUTO" } });
      if (memberIds.length) {
        const manual = await tx.segmentMember.findMany({
          where: { segmentId: segment.id, source: "MANUAL" },
          select: { customerId: true },
        });
        const manualSet = new Set(manual.map((m) => m.customerId));
        const toInsert = memberIds.filter((id) => !manualSet.has(id));
        if (toInsert.length) {
          await tx.segmentMember.createMany({
            data: toInsert.map((customerId) => ({
              segmentId: segment.id,
              customerId,
              source: "AUTO" as const,
            })),
          });
        }
      }
    });
  }
}

/**
 * AUDIT FIX (F08/F09) — SHARED transactional aggregate rebuild.
 *
 * Every write path that touches RestaurantVisit (create / edit amount / edit
 * date / delete / import) MUST call this helper afterwards. It recomputes the
 * customer's restaurant aggregates FROM the authoritative visit list:
 *
 *   - totalRestaurantVisits / diningFrequency: count of visits
 *   - totalRestaurantSpend:                    sum of orderAmount
 *   - lastRestaurantVisit:                     MAX(visitDate) — a backdated
 *                                              historical entry can never drag
 *                                              the latest-visit date backwards
 *                                              (F09), and an amount edit always
 *                                              leaves spend consistent (F08)
 *   - favouriteCategory / favouriteItems:      refreshed from the most recent
 *                                              visits when a hint is provided
 *
 * Money is summed with rounded rupee arithmetic to avoid float drift.
 */
export async function rebuildRestaurantAggregates(
  customerId: string,
  opts: { favouriteCategory?: string | null; favouriteItems?: string[] | null } = {},
): Promise<void> {
  const visits = await db.restaurantVisit.findMany({
    where: { customerId },
    select: { orderAmount: true, visitDate: true, foodCategory: true, favouriteItems: true },
    orderBy: { visitDate: "desc" },
  });
  const totalSpend = Math.round(visits.reduce((s, v) => s + v.orderAmount, 0) * 100) / 100;
  const lastVisit = visits.length
    ? visits.reduce((a, b) => (a.visitDate > b.visitDate ? a : b)).visitDate
    : null;

  let favouriteCategory: string | null | undefined = opts.favouriteCategory ?? undefined;
  if (favouriteCategory === undefined && visits.length) {
    // Most recent non-empty category among recent visits (fallback behaviour
    // preserved from the original inline logic).
    favouriteCategory = visits.find((v) => (v.foodCategory ?? "").length > 0)?.foodCategory ?? null;
  }

  await db.customer.update({
    where: { id: customerId },
    data: {
      totalRestaurantVisits: visits.length,
      totalRestaurantSpend: totalSpend,
      diningFrequency: visits.length,
      lastRestaurantVisit: lastVisit,
      ...(favouriteCategory !== undefined ? { favouriteCategory } : {}),
    },
  });
}

export async function recordRestaurantVisit(params: {
  hotelId: string;
  customerId: string;
  visitDate: Date;
  tableNumber?: string;
  guests?: number;
  orderAmount: number;
  foodCategory?: string;
  favouriteItems?: string[];
  source?:
    | "WALK_IN"
    | "RESERVATION"
    | "ROOM_GUEST"
    | "EVENT"
    | "ONLINE_ORDER"
    | "QR_MENU"
    | "WIFI_LOGIN"
    | "FEEDBACK"
    | "LOYALTY";
  notes?: string;
  userId?: string | null;
}) {
  const visit = await db.restaurantVisit.create({
    data: {
      hotelId: params.hotelId,
      customerId: params.customerId,
      visitDate: params.visitDate,
      tableNumber: params.tableNumber ?? null,
      guests: params.guests ?? 1,
      orderAmount: params.orderAmount,
      foodCategory: params.foodCategory ?? null,
      favouriteItems: params.favouriteItems ? JSON.stringify(params.favouriteItems) : null,
      source: params.source ?? "WALK_IN",
      notes: params.notes ?? null,
    },
  });

  // AUDIT FIX (F08/F09): ALL customer restaurant aggregates are now rebuilt
  // through ONE shared, authoritative helper — the visit list itself is the
  // single source of truth. Fixes two concrete bugs:
  //   F08 — editing a bill amount used to leave totalRestaurantSpend stale
  //         (PATCH had no rebuild; only DELETE did).
  //   F09 — a HISTORICAL (backdated) visit used to drag lastRestaurantVisit
  //         backwards (lastRestaurantVisit was set to the inserted date, not
  //         the MAX visit date).
  await rebuildRestaurantAggregates(params.customerId, { favouriteCategory: params.foodCategory });

  await db.timelineEvent.create({
    data: {
      hotelId: params.hotelId,
      customerId: params.customerId,
      type: "RESTAURANT_VISIT",
      label: "Restaurant visit recorded",
      detail: `Table ${params.tableNumber ?? "—"} · ${params.guests ?? 1} guests · ₹${params.orderAmount.toFixed(2)}`,
      amount: params.orderAmount,
      userId: params.userId ?? null,
    },
  });

  await logAudit({
    hotelId: params.hotelId,
    userId: params.userId ?? null,
    action: AUDIT_ACTIONS.VISIT_CREATED,
    entityType: "restaurant_visit",
    entityId: visit.id,
    metadata: { customer: params.customerId, amount: params.orderAmount },
  });

  // Phase 6.3 — award loyalty points for this visit (real engine, idempotent
  // per visit; silently no-ops when loyalty is disabled for the hotel).
  let loyaltyAward: { pointsAwarded: number; balance: number; tier: string } | null = null;
  try {
    const settings = await db.loyaltySettings.findUnique({ where: { hotelId: params.hotelId } });
    if (!settings || settings.enabled) {
      const award = await awardForRestaurantVisit(
        params.hotelId,
        params.customerId,
        visit.id,
        params.orderAmount,
      );
      if (award.ok) {
        loyaltyAward = {
          pointsAwarded: award.pointsAwarded,
          balance: award.balance,
          tier: award.tier,
        };
      }
    }
  } catch (err) {
    // Loyalty awarding must never break visit recording.
    console.error("[loyalty] award failed:", err instanceof Error ? err.message : err);
  }

  return { ...visit, loyaltyAward: loyaltyAward ?? undefined };
}

/** Top restaurant customers by total spend (for the leaderboard). */
export async function restaurantLeaderboard(hotelId: string, limit = 10) {
  const customers = await db.customer.findMany({
    where: { hotelId, totalRestaurantVisits: { gt: 0 } },
    select: {
      id: true,
      name: true,
      phone: true,
      totalRestaurantVisits: true,
      totalRestaurantSpend: true,
      lastRestaurantVisit: true,
      vip: true,
    },
    orderBy: { totalRestaurantSpend: "desc" },
    take: limit,
  });
  return customers;
}

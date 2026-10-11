import { db } from "@/lib/db";

/**
 * Segmentation Engine — Phase 2
 *
 * Automatically divides a hotel's customers into meaningful groups.
 * Rules are evaluated in-process from aggregated visit data (works identically
 * on SQLite in the sandbox and PostgreSQL in production; for very large hotels
 * the same predicates can be pushed into SQL — see README roadmap).
 *
 * Built-in AUTO segments (per hotel):
 *  - New Customer   : exactly 1 booking
 *  - Returning      : 2+ bookings
 *  - VIP            : flagged VIP by staff OR lifetime spend >= vipSpendThreshold
 *  - Inactive       : last visit 90+ days ago (has at least one visit)
 *  - Recent         : visited within the last 7-30 days
 *  - Birthday       : birthday within the next 14 days
 *  - Anniversary    : anniversary within the next 14 days
 *  - Weekend        : majority of stays begin on Fri/Sat/Sun
 *  - High Value     : lifetime spend >= highValueSpendThreshold
 */

export interface SegmentRule {
  kind:
    | "new_customer"
    | "returning"
    | "vip"
    | "inactive"
    | "recent"
    | "birthday"
    | "anniversary"
    | "weekend"
    | "high_value";
  params?: {
    days?: number; // inactive window / birthday-anniversary lookahead
    minSpend?: number; // vip / high_value threshold (INR)
    weekendRatio?: number; // weekend segment
  };
}

export interface CustomerIntelligence {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  marketingConsent: boolean;
  optOut: boolean;
  status: string;
  vip: boolean;
  birthday: Date | null;
  anniversary: Date | null;
  totalVisits: number;
  totalSpend: number;
  lastVisitAt: Date | null;
  firstVisitAt: Date | null;
  weekendStays: number;
}

export const SYSTEM_SEGMENTS: {
  name: string;
  description: string;
  rule: SegmentRule;
  color: string;
}[] = [
  {
    name: "New Customer",
    description: "Guests with exactly one booking so far.",
    rule: { kind: "new_customer" },
    color: "sky",
  },
  {
    name: "Returning",
    description: "Guests who have stayed 2 or more times.",
    rule: { kind: "returning" },
    color: "emerald",
  },
  {
    name: "VIP",
    description: "Flagged VIP by your team or very high lifetime spend.",
    rule: { kind: "vip", params: { minSpend: 100000 } },
    color: "amber",
  },
  {
    name: "Inactive",
    description: "No visit in the last 90 days — win-back candidates.",
    rule: { kind: "inactive", params: { days: 90 } },
    color: "rose",
  },
  {
    name: "Recent",
    description: "Stayed within the last 7-30 days.",
    rule: { kind: "recent" },
    color: "teal",
  },
  {
    name: "Birthday",
    description: "Birthday falls within the next 14 days.",
    rule: { kind: "birthday", params: { days: 14 } },
    color: "violet",
  },
  {
    name: "Anniversary",
    description: "Anniversary falls within the next 14 days.",
    rule: { kind: "anniversary", params: { days: 14 } },
    color: "pink",
  },
  {
    name: "Weekend Customer",
    description: "Most stays begin on a Friday, Saturday or Sunday.",
    rule: { kind: "weekend", params: { weekendRatio: 0.6 } },
    color: "orange",
  },
  {
    name: "High Value",
    description: "Lifetime spending crosses the high-value threshold.",
    rule: { kind: "high_value", params: { minSpend: 50000 } },
    color: "lime",
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Days until the next occurrence of a yearly date (0 = today). */
export function daysUntilNextYearly(date: Date, today = new Date()): number {
  const t = startOfDay(today);
  const thisYear = new Date(t.getFullYear(), date.getMonth(), date.getDate());
  if (thisYear.getTime() >= t.getTime()) {
    return Math.round((startOfDay(thisYear).getTime() - t.getTime()) / DAY_MS);
  }
  const nextYear = new Date(t.getFullYear() + 1, date.getMonth(), date.getDate());
  return Math.round((startOfDay(nextYear).getTime() - t.getTime()) / DAY_MS);
}

/** Load a hotel's customers with aggregated visit intelligence. */
export async function loadCustomerIntelligence(hotelId: string): Promise<CustomerIntelligence[]> {
  const customers = await db.customer.findMany({
    where: { hotelId },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      marketingConsent: true,
      optOut: true,
      status: true,
      vip: true,
      birthday: true,
      anniversary: true,
      visits: {
        select: { checkin: true, checkout: true, amount: true },
        orderBy: { checkin: "asc" },
      },
    },
  });

  return customers.map((c) => {
    const visits = c.visits;
    const totalSpend = visits.reduce((sum, v) => sum + (v.amount ?? 0), 0);
    const weekendStays = visits.filter((v) => {
      const day = new Date(v.checkin).getDay(); // 0 Sun, 5 Fri, 6 Sat
      return day === 5 || day === 6 || day === 0;
    }).length;
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      marketingConsent: c.marketingConsent,
      optOut: c.optOut,
      status: c.status,
      vip: c.vip,
      birthday: c.birthday,
      anniversary: c.anniversary,
      totalVisits: visits.length,
      totalSpend,
      firstVisitAt: visits.length ? visits[0].checkin : null,
      lastVisitAt: visits.length ? visits[visits.length - 1].checkin : null,
      weekendStays,
    };
  });
}

/** Evaluate one AUTO segment rule against a customer. */
export function matchesRule(c: CustomerIntelligence, rule: SegmentRule, now = new Date()): boolean {
  const p = rule.params ?? {};
  switch (rule.kind) {
    case "new_customer":
      return c.totalVisits === 1;
    case "returning":
      return c.totalVisits >= 2;
    case "vip":
      return c.vip || (p.minSpend !== undefined && c.totalSpend >= p.minSpend);
    case "inactive": {
      const days = p.days ?? 90;
      if (c.totalVisits === 0 || !c.lastVisitAt) return false;
      return (now.getTime() - c.lastVisitAt.getTime()) / DAY_MS >= days;
    }
    case "recent": {
      if (!c.lastVisitAt) return false;
      const ago = (now.getTime() - c.lastVisitAt.getTime()) / DAY_MS;
      return ago >= 7 && ago <= 30;
    }
    case "birthday":
      return c.birthday !== null && daysUntilNextYearly(c.birthday, now) <= (p.days ?? 14);
    case "anniversary":
      return c.anniversary !== null && daysUntilNextYearly(c.anniversary, now) <= (p.days ?? 14);
    case "weekend": {
      if (c.totalVisits === 0) return false;
      const ratio = p.weekendRatio ?? 0.6;
      return c.weekendStays / c.totalVisits >= ratio;
    }
    case "high_value":
      return p.minSpend !== undefined && c.totalSpend >= p.minSpend;
    default:
      return false;
  }
}

/** Get-or-create the nine system AUTO segments for a hotel. */
export async function ensureSystemSegments(hotelId: string) {
  const existing = await db.segment.findMany({
    where: { hotelId, isSystem: true },
  });
  const byName = new Map(existing.map((s) => [s.name, s]));

  for (const def of SYSTEM_SEGMENTS) {
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
        },
      });
    }
  }
  return db.segment.findMany({ where: { hotelId, isSystem: true }, orderBy: { name: "asc" } });
}

export interface RefreshResult {
  segmentId: string;
  name: string;
  kind: SegmentRule["kind"];
  memberCount: number;
}

/**
 * Recompute ALL AUTO segments for a hotel.
 * AUTO memberships are rebuilt from scratch; MANUAL memberships are untouched.
 */
export async function refreshAutoSegments(
  hotelId: string,
  now = new Date(),
): Promise<RefreshResult[]> {
  await ensureSystemSegments(hotelId);
  const segments = await db.segment.findMany({ where: { hotelId, type: "AUTO" } });
  const customers = await loadCustomerIntelligence(hotelId);

  const results: RefreshResult[] = [];
  for (const segment of segments) {
    let rule: SegmentRule;
    try {
      rule = JSON.parse(segment.rule ?? "{}") as SegmentRule;
    } catch {
      continue;
    }
    const memberIds = customers.filter((c) => matchesRule(c, rule, now)).map((c) => c.id);

    // Rebuild AUTO memberships inside a transaction.
    // MANUAL picks are preserved; AUTO re-inserts skip them (unique constraint).
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

    const ruleKind = (JSON.parse(segment.rule ?? "{}") as SegmentRule).kind ?? "new_customer";
    results.push({
      segmentId: segment.id,
      name: segment.name,
      kind: ruleKind,
      memberCount: memberIds.length,
    });
  }
  return results;
}

/** Members of a segment (AUTO rules are evaluated live so the list is never stale). */
export function parseRuleSafe(raw: string | null | undefined): SegmentRule | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SegmentRule;
    return parsed && typeof parsed.kind === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function getSegmentMemberIds(segmentId: string, hotelId: string): Promise<string[]> {
  const segment = await db.segment.findFirst({ where: { id: segmentId, hotelId } });
  if (!segment) return [];
  if (segment.type === "AUTO" && segment.rule) {
    try {
      const rule = JSON.parse(segment.rule) as SegmentRule;
      const customers = await loadCustomerIntelligence(hotelId);
      return customers.filter((c) => matchesRule(c, rule)).map((c) => c.id);
    } catch {
      return [];
    }
  }
  const rows = await db.segmentMember.findMany({
    where: { segmentId },
    select: { customerId: true },
  });
  return rows.map((r) => r.customerId);
}

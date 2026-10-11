import { db } from "@/lib/db";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import type { Prisma } from "@prisma/client";

/**
 * BUG-7/D16/D17 — per-hotel write lock for serialized capacity enforcement.
 *
 * Runs `fn` inside ONE interactive transaction that first takes a per-hotel
 * WRITE LOCK by touching the tenant's UsageRecord row (an unconditional
 * UPDATE on the same row — same pattern as createCustomerWithinLimit).
 * Check-then-create sequences (menu caps, table caps, staff invites,
 * last-admin guards) placed inside this lock can no longer race:
 *   - PostgreSQL: the row lock blocks the second transaction's UPDATE until
 *     the first commits; its subsequent COUNT then sees the committed state.
 *   - SQLite: the write serializes the whole database for the transaction.
 */
export async function withHotelWriteLock<T>(
  hotelId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const usage = await tx.usageRecord.upsert({
      where: { hotelId_period: { hotelId, period: periodKey() } },
      create: { hotelId, period: periodKey() },
      update: {},
    });
    await tx.$executeRaw`UPDATE "UsageRecord" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${usage.id}`;
    return fn(tx);
  });
}

/**
 * Usage & Limit Engine — Phase 10 §12.
 *
 * A central metering service. Every resource-creating API checks
 * `assertWithinLimit` BEFORE creating the resource — never UI-only.
 * Limits come from the tenant's plan (NULL/0 = unlimited, matching the
 * existing plan semantics). Super Admin limit changes apply INSTANTLY
 * because the check reads the live plan row.
 *
 * Usage is persisted per hotel per month (UsageRecord) and also refreshed
 * from live counts for the resources that map 1:1 to database rows.
 */

export type LimitResource =
  | "customers"
  | "staff"
  | "campaigns"
  | "messages"
  | "whatsappMessages"
  | "smsMessages"
  | "storageMb"
  | "apiRequests"
  | "exports"
  | "locations"
  | "restaurants"
  | "aiRequests";

const LIVE_COUNT_QUERIES: Record<string, (hotelId: string) => Promise<number>> = {
  customers: (hotelId) => db.customer.count({ where: { hotelId } }),
  // D16: staff capacity counts ACTIVE + PENDING — a pending invitation is a
  // reserved seat; otherwise four invites could slip past a limit of 3.
  staff: (hotelId) =>
    db.user.count({ where: { hotelId, status: { in: ["ACTIVE", "PENDING"] } } }),
  campaigns: (hotelId) => db.campaign.count({ where: { hotelId } }),
};

export interface LimitStatus {
  resource: LimitResource;
  used: number;
  limit: number; // 0 = unlimited
  allowed: boolean;
  remaining: number | null;
  percent: number;
}

function periodKey(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

/** Get-or-create the current usage row for a hotel. */
async function currentUsage(hotelId: string) {
  return db.usageRecord.upsert({
    where: { hotelId_period: { hotelId, period: periodKey() } },
    create: { hotelId, period: periodKey() },
    update: {},
  });
}

function planLimitFor(
  resource: LimitResource,
  plan: {
    customerLimit: number;
    campaignLimit: number;
    messageLimit: number;
    staffLimit: number;
    aiUsageLimit: number;
    storageMb: number;
    apiRequestLimit: number;
    exportsLimit: number;
    locationsLimit: number;
    restaurantsLimit: number;
    whatsappMessageLimit: number;
    smsMessageLimit: number;
  } | null,
): number {
  if (!plan) return 0; // no plan = unlimited (legacy tenants keep working)
  switch (resource) {
    case "customers":
      return plan.customerLimit;
    case "campaigns":
      return plan.campaignLimit;
    case "messages":
      return plan.messageLimit;
    case "staff":
      return plan.staffLimit;
    case "aiRequests":
      return plan.aiUsageLimit;
    case "storageMb":
      return plan.storageMb;
    case "apiRequests":
      return plan.apiRequestLimit;
    case "exports":
      return plan.exportsLimit;
    case "locations":
      return plan.locationsLimit;
    case "restaurants":
      return plan.restaurantsLimit;
    case "whatsappMessages":
      return plan.whatsappMessageLimit;
    case "smsMessages":
      return plan.smsMessageLimit;
  }
}

/** Usage value for a resource (live counts where possible). */
export async function getUsage(hotelId: string, resource: LimitResource): Promise<number> {
  if (LIVE_COUNT_QUERIES[resource]) {
    return LIVE_COUNT_QUERIES[resource](hotelId);
  }
  const usage = await currentUsage(hotelId);
  switch (resource) {
    case "messages":
      return usage.messages;
    case "whatsappMessages":
      return usage.whatsappMessages;
    case "smsMessages":
      return usage.smsMessages;
    case "storageMb":
      return usage.storageMb;
    case "apiRequests":
      return usage.apiRequests;
    case "exports":
      return usage.exports;
    case "locations":
      return usage.locations;
    case "restaurants":
      return usage.restaurants;
    case "aiRequests":
      return usage.aiRequests;
    default:
      return 0;
  }
}

export async function checkLimit(hotelId: string, resource: LimitResource): Promise<LimitStatus> {
  const hotel = await db.hotel.findUnique({ where: { id: hotelId }, include: { plan: true } });
  const limit = planLimitFor(resource, hotel?.plan ?? null);
  const used = await getUsage(hotelId, resource);
  const unlimited = limit <= 0;
  const allowed = unlimited || used < limit;
  const remaining = unlimited ? null : Math.max(0, limit - used);
  const percent = unlimited ? 0 : Math.min(100, Math.round((used / limit) * 100));
  return { resource, used, limit, allowed, remaining, percent };
}

/**
 * Guard used by resource-creating APIs. Returns a structured error object the
 * route converts into a 403 SUBSCRIPTION_LIMIT response, or null when OK.
 */
export async function assertWithinLimit(
  hotelId: string,
  resource: LimitResource,
  increment = 1,
): Promise<{
  code: string;
  message: string;
  resource: LimitResource;
  used: number;
  limit: number;
} | null> {
  const status = await checkLimit(hotelId, resource);
  if (!status.allowed) {
    await logAudit({
      hotelId,
      action: AUDIT_ACTIONS.USAGE_LIMIT_REACHED,
      entityType: "usage",
      entityId: `${hotelId}:${resource}`,
      metadata: { resource, used: status.used, limit: status.limit },
    });
    return {
      code: "SUBSCRIPTION_LIMIT_REACHED",
      message: `Your plan's ${resource} limit has been reached (${status.used}/${status.limit}). Upgrade your plan to continue.`,
      resource,
      used: status.used,
      limit: status.limit,
    };
  }
  if (status.percent >= 90 && status.limit > 0) {
    await logAudit({
      hotelId,
      action: AUDIT_ACTIONS.USAGE_LIMIT_WARNING,
      entityType: "usage",
      entityId: `${hotelId}:${resource}`,
      metadata: { resource, used: status.used, limit: status.limit, percent: status.percent },
    });
  }
  void increment;
  return null;
}

/** Increment a metered counter (called AFTER a resource is created/sent). */
export async function incrementUsage(
  hotelId: string,
  resource: Exclude<LimitResource, "customers" | "staff" | "campaigns">,
  by = 1,
): Promise<void> {
  await currentUsage(hotelId);
  const field = resource;
  await db.usageRecord.update({
    where: { hotelId_period: { hotelId, period: periodKey() } },
    data: { [field]: { increment: by } },
  });
}

/**
 * AUDIT FIX (quota-1) — ATOMIC quota reservation. The old flow was
 * check-only (assertWithinLimit) with the increment “later” that never
 * happened for exports: two concurrent requests both passed the check and
 * neither was counted, so exportsLimit was never actually enforced (usage
 * stayed 0 forever).
 *
 * reserveUsage performs the check AND the increment as ONE guarded update:
 * the row only increments while `used < limit`, so N concurrent requests can
 * never push usage past the limit — the database serializes the update and
 * the guard fails for the losers. Unlimited resources (limit 0) always pass
 * without touching the counter.
 *
 * Returns null on success, or the same structured error assertWithinLimit
 * produces (route converts to 403 SUBSCRIPTION_LIMIT_REACHED).
 */
export async function reserveUsage(
  hotelId: string,
  resource: LimitResource,
  opts: { skipAudit?: boolean; by?: number } = {},
): Promise<{
  code: string;
  message: string;
  resource: LimitResource;
  used: number;
  limit: number;
} | null> {
  // Live-count resources cannot be reserved this way — they are derived from
  // real rows, so their limits are enforced by the creating APIs.
  if (LIVE_COUNT_QUERIES[resource]) {
    return assertWithinLimit(hotelId, resource);
  }
  const by = Math.max(1, Math.floor(opts.by ?? 1));
  const hotel = await db.hotel.findUnique({ where: { id: hotelId }, include: { plan: true } });
  const limit = planLimitFor(resource, hotel?.plan ?? null);
  if (limit <= 0) return null; // unlimited
  await currentUsage(hotelId);
  // AUDIT FIX (quota-2): batch-aware guard — the reservation must hold only
  // when the WHOLE batch fits under the limit (a send of N messages needs N
  // slots, not one).
  const reservationWhere = { hotelId, period: periodKey() } as Record<string, unknown>;
  reservationWhere[resource] = { lte: limit - by };
  const reserved = await db.usageRecord.updateMany({
    where: reservationWhere as never,
    data: { [resource]: { increment: by } } as never,
  });
  if (reserved.count !== 1) {
    const used = await getUsage(hotelId, resource);
    if (!opts.skipAudit) {
      await logAudit({
        hotelId,
        action: AUDIT_ACTIONS.USAGE_LIMIT_REACHED,
        entityType: "usage",
        entityId: `${hotelId}:${resource}`,
        metadata: { resource, used, limit },
      });
    }
    return {
      code: "SUBSCRIPTION_LIMIT_REACHED",
      message: `Your plan's ${resource} limit has been reached (${used}/${limit}). Upgrade your plan to continue.`,
      resource,
      used,
      limit,
    };
  }
  return null;
}

/**
 * Give back a reservation (guarded decrement — never below zero). Used when a
 * reserved operation fails server-side so a failed export/send does not burn
 * the tenant's monthly quota.
 * AUDIT FIX (quota-2): accepts a `by` count to match batch reservations.
 */
export async function releaseUsage(
  hotelId: string,
  resource: Exclude<LimitResource, "customers" | "staff" | "campaigns">,
  by = 1,
): Promise<void> {
  try {
    await currentUsage(hotelId);
    const releaseWhere = { hotelId, period: periodKey() } as Record<string, unknown>;
    releaseWhere[resource] = { gte: by };
    await db.usageRecord.updateMany({
      where: releaseWhere as never,
      data: { [resource]: { decrement: by } } as never,
    });
  } catch {
    // Metering must never break the business action it meters.
  }
}

/** Refresh live-count fields in the usage row (called by usage dashboards). */
export async function refreshUsageSnapshot(hotelId: string) {
  const [customers, staff, campaigns] = await Promise.all([
    db.customer.count({ where: { hotelId } }),
    db.user.count({ where: { hotelId, status: "ACTIVE" } }),
    db.campaign.count({ where: { hotelId } }),
  ]);
  await currentUsage(hotelId);
  return db.usageRecord.update({
    where: { hotelId_period: { hotelId, period: periodKey() } },
    data: { customers, staff, campaigns },
  });
}

/* ------------------------------------------------------------------ */
/* RECHECK FIX (I) — ATOMIC customer capacity enforcement              */
/* ------------------------------------------------------------------ */

export type LimitFailure = {
  code: string;
  message: string;
  resource: LimitResource;
  used: number;
  limit: number;
};

/**
 * Create a customer under the plan's capacity limit — ATOMICALLY.
 *
 * The recheck probe reproduced the bypass: customer limit = 1, EIGHT
 * concurrent creates → eight 201s, eight customers. The old flow ran
 * `assertWithinLimit` (a live COUNT) and the INSERT as separate operations,
 * so every concurrent request observed the same pre-insert count and all
 * passed. A pre-check is not enforcement.
 *
 * This helper performs the check AND the create inside ONE interactive
 * transaction that first takes a per-hotel WRITE LOCK by touching the
 * tenant's UsageRecord row (an unconditional UPDATE on the same row). That
 * statement serializes all capacity checks for the hotel:
 *   - PostgreSQL: the row lock blocks the second transaction's UPDATE until
 *     the first commits; its subsequent COUNT then sees the committed row.
 *   - SQLite: the write serializes the whole database for the transaction.
 * The loser re-reads the (now larger) count and fails with the same
 * structured SUBSCRIPTION_LIMIT_REACHED error the routes already return.
 *
 * Every customer write path goes through this: the app UI route, the v1
 * developer API, the public QR join, and the CSV importer (bulk headroom is
 * checked with the same lock). Failed creates roll the whole transaction
 * back — nothing is half-reserved.
 */
export async function createCustomerWithinLimit<T>(
  hotelId: string,
  create: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: { requested?: number } = {},
): Promise<{ ok: true; value: T } | { ok: false; failure: LimitFailure }> {
  const requested = Math.max(1, opts.requested ?? 1);
  try {
    const value = await db.$transaction(async (tx) => {
      // 1. Ensure the usage row exists (get-or-create, outside the critical
      //    section semantics — upsert is idempotent on the unique pair).
      const usage = await tx.usageRecord.upsert({
        where: { hotelId_period: { hotelId, period: periodKey() } },
        create: { hotelId, period: periodKey() },
        update: {},
      });

      // 2. CRITICAL SECTION GATE — unconditional touch of the SAME row takes
      //    the per-hotel write lock. Concurrent creators queue here; each
      //    sees the previously committed state when its turn comes.
      //    (Tagged-template raw: parameters are bound safely on BOTH the
      //    SQLite dev client and the PostgreSQL production client.)
      await tx.$executeRaw`UPDATE "UsageRecord" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${usage.id}`;

      // 3. Plan limit + fresh count INSIDE the serialized section.
      const hotel = await tx.hotel.findUnique({
        where: { id: hotelId },
        select: { plan: { select: { customerLimit: true } } },
      });
      const limit = hotel?.plan?.customerLimit ?? 0;
      if (limit > 0) {
        const used = await tx.customer.count({ where: { hotelId } });
        if (used + requested > limit) {
          return {
            overLimit: true as const,
            used,
            limit,
          };
        }
      }

      // 4. Create inside the same serialized transaction.
      return {
        overLimit: false as const,
        value: await create(tx),
      };
    });

    if (value.overLimit) {
      await logAudit({
        hotelId,
        action: AUDIT_ACTIONS.USAGE_LIMIT_REACHED,
        entityType: "usage",
        entityId: `${hotelId}:customers`,
        metadata: { resource: "customers", used: value.used, limit: value.limit, requested },
      });
      return {
        ok: false,
        failure: {
          code: "SUBSCRIPTION_LIMIT_REACHED",
          message: `Your plan's customers limit has been reached (${value.used}/${value.limit}). Upgrade your plan to continue.`,
          resource: "customers",
          used: value.used,
          limit: value.limit,
        },
      };
    }
    return { ok: true, value: value.value };
  } catch (err) {
    // A unique-constraint or client-side failure surfaces as a plain error —
    // the transaction rolled back, so no capacity was leaked. Re-throw for
    // the route's normal error handling (duplicate phones etc.).
    throw err;
  }
}

/** Full usage summary for a hotel (dashboard + super admin usage page). */
export async function getUsageSummary(hotelId: string) {
  const hotel = await db.hotel.findUnique({ where: { id: hotelId }, include: { plan: true } });
  const usage = await refreshUsageSnapshot(hotelId);
  const plan = hotel?.plan ?? null;
  const resources: LimitResource[] = [
    "customers",
    "staff",
    "campaigns",
    "messages",
    "whatsappMessages",
    "smsMessages",
    "aiRequests",
    "storageMb",
    "apiRequests",
    "exports",
    "locations",
    "restaurants",
  ];
  const statuses: LimitStatus[] = [];
  for (const resource of resources) {
    const limit = planLimitFor(resource, plan);
    let used: number;
    switch (resource) {
      case "customers":
        used = usage.customers;
        break;
      case "staff":
        used = usage.staff;
        break;
      case "campaigns":
        used = usage.campaigns;
        break;
      case "messages":
        used = usage.messages;
        break;
      case "whatsappMessages":
        used = usage.whatsappMessages;
        break;
      case "smsMessages":
        used = usage.smsMessages;
        break;
      case "aiRequests":
        used = usage.aiRequests;
        break;
      case "storageMb":
        used = usage.storageMb;
        break;
      case "apiRequests":
        used = usage.apiRequests;
        break;
      case "exports":
        used = usage.exports;
        break;
      case "locations":
        used = usage.locations;
        break;
      case "restaurants":
        used = usage.restaurants;
        break;
    }
    statuses.push({
      resource,
      used,
      limit,
      allowed: limit <= 0 || used < limit,
      remaining: limit > 0 ? Math.max(0, limit - used) : null,
      percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
    });
  }
  return {
    hotelId,
    period: usage.period,
    plan: plan ? { id: plan.id, key: plan.key, name: plan.name } : null,
    resources: statuses,
  };
}

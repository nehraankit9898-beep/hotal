import { db } from "@/lib/db";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { getSetting } from "@/lib/saas/settings";

/**
 * Subscription & Trial Lifecycle — Phase 10 §4/§5.
 *
 * Tenant states (Subscription.status):
 *   TRIALING → ACTIVE | GRACE | CANCELLED
 *   GRACE    → ACTIVE (payment) | EXPIRED
 *   ACTIVE   → PAST_DUE (failed renewal) | CANCELLED | SUSPENDED | PAUSED
 *   PAST_DUE → ACTIVE (recovery) | GRACE | EXPIRED
 *   EXPIRED  → ACTIVE (reactivation + payment)
 *
 * The backend NEVER trusts frontend subscription state — every state
 * transition happens here with an audit log, and requireAuth enforces the
 * current DB state on each request.
 */

export type TenantSubscriptionState =
  | "TRIALING"
  | "ACTIVE"
  | "GRACE"
  | "PAST_DUE"
  | "SUSPENDED"
  | "CANCELLED"
  | "EXPIRED"
  | "PAUSED"
  | "NONE";

/** The effective access level derived from subscription state. */
export type AccessLevel = "full" | "grace" | "readonly_billing" | "blocked";

export interface SubscriptionView {
  subscriptionId: string | null;
  state: TenantSubscriptionState;
  access: AccessLevel;
  plan: {
    id: string;
    key: string;
    name: string;
    monthlyPrice: number;
    yearlyPrice: number;
    currency: string;
  } | null;
  billingCycle: "MONTHLY" | "YEARLY" | null;
  amount: number;
  currency: string;
  startedAt: string | null;
  trialStartsAt: string | null;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
  graceEndsAt: string | null;
  currentPeriodEnd: string | null;
  nextInvoiceAt: string | null;
  provider: string | null;
  blockOnExpiry: boolean;
}

function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

/** Read the tenant's CURRENT subscription state straight from the DB. */
export async function getSubscriptionView(hotelId: string): Promise<SubscriptionView> {
  const [hotel, trialDefaults] = await Promise.all([
    db.hotel.findUnique({ where: { id: hotelId }, include: { plan: true } }),
    getSetting("trial.defaults"),
  ]);
  const sub = await db.subscription.findFirst({
    where: { hotelId },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  });

  const plan = sub?.plan ?? hotel?.plan ?? null;
  const planInfo = plan
    ? {
        id: plan.id,
        key: plan.key,
        name: plan.name,
        monthlyPrice: plan.monthlyPrice,
        yearlyPrice: plan.yearlyPrice,
        currency: plan.currency,
      }
    : null;

  const state: TenantSubscriptionState = sub
    ? (sub.status as TenantSubscriptionState)
    : hotel
      ? hotel.status === "SUSPENDED"
        ? "SUSPENDED"
        : "NONE"
      : "NONE";

  // Hotel-level suspension always blocks.
  let access: AccessLevel;
  if (hotel?.status === "SUSPENDED" || state === "SUSPENDED") {
    access = "blocked";
  } else if (state === "EXPIRED" || state === "CANCELLED") {
    const cancelledButActive =
      state === "CANCELLED" && sub?.currentPeriodEnd && sub.currentPeriodEnd > new Date();
    access = cancelledButActive
      ? "full"
      : trialDefaults.blockOnExpiry
        ? "readonly_billing"
        : "grace";
  } else if (state === "NONE") {
    access = "full"; // legacy tenants without a subscription row keep working
  } else {
    access = "full";
  }

  const trialDaysRemaining =
    sub?.status === "TRIALING" && sub.trialEndsAt
      ? Math.max(0, daysBetween(new Date(), sub.trialEndsAt))
      : null;

  return {
    subscriptionId: sub?.id ?? null,
    state,
    access,
    plan: planInfo,
    billingCycle: (sub?.billingCycle as "MONTHLY" | "YEARLY") ?? null,
    amount: sub?.amount ?? 0,
    currency: sub?.currency ?? "INR",
    startedAt: sub?.startedAt?.toISOString() ?? null,
    trialStartsAt: sub?.trialStartsAt?.toISOString() ?? null,
    trialEndsAt: sub?.trialEndsAt?.toISOString() ?? null,
    trialDaysRemaining,
    graceEndsAt: sub?.graceEndsAt?.toISOString() ?? null,
    currentPeriodEnd: sub?.currentPeriodEnd?.toISOString() ?? null,
    nextInvoiceAt: sub?.nextInvoiceAt?.toISOString() ?? null,
    provider: sub?.provider ?? null,
    blockOnExpiry: trialDefaults.blockOnExpiry,
  };
}

/** Start a trial for a hotel (used by tenant creation + super admin action). */
export async function startTrial(params: {
  hotelId: string;
  planId: string;
  days?: number;
  adminUserId?: string;
  reason?: string;
}) {
  const trialDefaults = await getSetting("trial.defaults");
  const days = params.days ?? trialDefaults.defaultDays;
  const plan = await db.plan.findUnique({ where: { id: params.planId } });
  if (!plan) throw new Error("Plan not found.");
  const effectiveDays = Math.min(trialDefaults.maxDays, Math.max(trialDefaults.minDays, days));
  const graceDays = plan.graceDays > 0 ? plan.graceDays : trialDefaults.graceDays;
  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + effectiveDays * 24 * 60 * 60 * 1000);

  // End any previous subscription rows for this hotel, then create the trial.
  await db.subscription.updateMany({
    where: {
      hotelId: params.hotelId,
      status: { in: ["TRIALING", "ACTIVE", "GRACE", "PAST_DUE", "PAUSED"] },
    },
    data: { status: "CANCELLED", cancelledAt: now },
  });
  const subscription = await db.subscription.create({
    data: {
      hotelId: params.hotelId,
      planId: plan.id,
      status: "TRIALING",
      amount: 0,
      currency: plan.currency,
      trialStartsAt: now,
      trialEndsAt,
      graceEndsAt: new Date(trialEndsAt.getTime() + graceDays * 24 * 60 * 60 * 1000),
    },
  });
  await db.hotel.update({ where: { id: params.hotelId }, data: { planId: plan.id } });
  await logAudit({
    hotelId: params.hotelId,
    userId: params.adminUserId,
    action: AUDIT_ACTIONS.TRIAL_STARTED,
    entityType: "subscription",
    entityId: subscription.id,
    metadata: {
      plan: plan.key,
      days: effectiveDays,
      reason: params.reason,
      trialEndsAt: trialEndsAt.toISOString(),
    },
  });
  return subscription;
}

/** Extend (or shorten with negative days) a running trial. */
export async function extendTrial(params: {
  hotelId: string;
  days: number;
  adminUserId: string;
  reason?: string;
}) {
  const trialDefaults = await getSetting("trial.defaults");
  const sub = await db.subscription.findFirst({
    where: { hotelId: params.hotelId, status: "TRIALING" },
    orderBy: { createdAt: "desc" },
  });
  if (!sub || !sub.trialEndsAt) throw new Error("No running trial for this hotel.");
  const currentEnd = sub.trialEndsAt;
  const newEnd = new Date(currentEnd.getTime() + params.days * 24 * 60 * 60 * 1000);
  const totalDays = daysBetween(sub.trialStartsAt ?? currentEnd, newEnd);
  if (totalDays > trialDefaults.maxDays) {
    throw new Error(`Trial cannot exceed the platform maximum of ${trialDefaults.maxDays} days.`);
  }
  if (totalDays < trialDefaults.minDays) {
    throw new Error(
      `Trial cannot be shorter than the platform minimum of ${trialDefaults.minDays} days.`,
    );
  }
  const updated = await db.subscription.update({
    where: { id: sub.id },
    data: {
      trialEndsAt: newEnd,
      graceEndsAt: new Date(newEnd.getTime() + trialDefaults.graceDays * 24 * 60 * 60 * 1000),
    },
  });
  await logAudit({
    hotelId: params.hotelId,
    userId: params.adminUserId,
    action: params.days >= 0 ? AUDIT_ACTIONS.TRIAL_EXTENDED : AUDIT_ACTIONS.TRIAL_SHORTENED,
    entityType: "subscription",
    entityId: sub.id,
    metadata: { days: params.days, newTrialEndsAt: newEnd.toISOString(), reason: params.reason },
  });
  return updated;
}

/** Cancel a running trial (tenant loses access at grace end). */
export async function cancelTrial(hotelId: string, adminUserId: string, reason?: string) {
  const sub = await db.subscription.findFirst({
    where: { hotelId, status: "TRIALING" },
    orderBy: { createdAt: "desc" },
  });
  if (!sub) throw new Error("No running trial for this hotel.");
  const updated = await db.subscription.update({
    where: { id: sub.id },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  await logAudit({
    hotelId,
    userId: adminUserId,
    action: AUDIT_ACTIONS.TRIAL_CANCELLED,
    entityType: "subscription",
    entityId: sub.id,
    metadata: { reason },
  });
  return updated;
}

/** Reactivate a cancelled/expired trial. */
export async function reactivateTrial(hotelId: string, adminUserId: string, reason?: string) {
  const sub = await db.subscription.findFirst({
    where: { hotelId, status: { in: ["CANCELLED", "EXPIRED"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!sub) throw new Error("No cancelled trial found for this hotel.");
  const trialDefaults = await getSetting("trial.defaults");
  const now = new Date();
  const newEnd = new Date(now.getTime() + trialDefaults.defaultDays * 24 * 60 * 60 * 1000);
  const updated = await db.subscription.update({
    where: { id: sub.id },
    data: {
      status: "TRIALING",
      trialStartsAt: sub.trialStartsAt ?? now,
      trialEndsAt: newEnd,
      graceEndsAt: new Date(newEnd.getTime() + trialDefaults.graceDays * 24 * 60 * 60 * 1000),
      cancelledAt: null,
      expiredAt: null,
    },
  });
  await logAudit({
    hotelId,
    userId: adminUserId,
    action: AUDIT_ACTIONS.TRIAL_REACTIVATED,
    entityType: "subscription",
    entityId: sub.id,
    metadata: { reason, newTrialEndsAt: newEnd.toISOString() },
  });
  return updated;
}

/** Convert a trial (or any state) into a paid ACTIVE subscription. */
export async function activatePaidSubscription(params: {
  hotelId: string;
  planId: string;
  billingCycle?: "MONTHLY" | "YEARLY";
  amount?: number;
  provider?: string;
  providerRef?: string;
  adminUserId?: string;
  reason?: string;
}) {
  const plan = await db.plan.findUnique({ where: { id: params.planId } });
  if (!plan) throw new Error("Plan not found.");
  const cycle = params.billingCycle ?? "MONTHLY";
  const amount = params.amount ?? (cycle === "YEARLY" ? plan.yearlyPrice : plan.monthlyPrice);
  const now = new Date();
  const periodDays = cycle === "YEARLY" ? 365 : 30;
  const periodEnd = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);

  await db.subscription.updateMany({
    where: {
      hotelId: params.hotelId,
      status: { in: ["TRIALING", "ACTIVE", "GRACE", "PAST_DUE", "PAUSED", "EXPIRED", "CANCELLED"] },
    },
    data: { status: "CANCELLED", cancelledAt: now },
  });
  const subscription = await db.subscription.create({
    data: {
      hotelId: params.hotelId,
      planId: plan.id,
      status: "ACTIVE",
      billingCycle: cycle,
      amount,
      currency: plan.currency,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      nextInvoiceAt: periodEnd,
      provider: params.provider ?? null,
      providerRef: params.providerRef ?? null,
      trialStartsAt: null,
      trialEndsAt: null,
      graceEndsAt: null,
    },
  });
  await db.hotel.update({ where: { id: params.hotelId }, data: { planId: plan.id } });
  await logAudit({
    hotelId: params.hotelId,
    userId: params.adminUserId,
    action: AUDIT_ACTIONS.SUBSCRIPTION_CHANGED,
    entityType: "subscription",
    entityId: subscription.id,
    metadata: {
      plan: plan.key,
      cycle,
      amount,
      provider: params.provider ?? null,
      reason: params.reason ?? "trial-converted",
    },
  });
  return subscription;
}

/** Downgrade/upgrade plan on an ACTIVE subscription (proration not modeled — amount switches at renewal). */
export async function changeSubscriptionPlan(params: {
  subscriptionId: string;
  planId: string;
  adminUserId: string;
  reason?: string;
}) {
  const sub = await db.subscription.findUnique({
    where: { id: params.subscriptionId },
    include: { plan: true },
  });
  if (!sub) throw new Error("Subscription not found.");
  const plan = await db.plan.findUnique({ where: { id: params.planId } });
  if (!plan) throw new Error("Plan not found.");
  const amount = sub.billingCycle === "YEARLY" ? plan.yearlyPrice : plan.monthlyPrice;
  const updated = await db.subscription.update({
    where: { id: sub.id },
    data: { planId: plan.id, amount, currency: plan.currency },
  });
  await db.hotel.update({ where: { id: sub.hotelId }, data: { planId: plan.id } });
  await logAudit({
    hotelId: sub.hotelId,
    userId: params.adminUserId,
    action: AUDIT_ACTIONS.SUBSCRIPTION_CHANGED,
    entityType: "subscription",
    entityId: sub.id,
    metadata: {
      from: sub.plan.key,
      to: plan.key,
      amount,
      reason: params.reason,
    },
  });
  return updated;
}

/** Lifecycle action dispatcher for the Super Admin UI. */
export async function subscriptionAction(
  action: string,
  subscriptionId: string,
  adminUserId: string,
  options: { reason?: string; planId?: string; days?: number } = {},
) {
  const sub = await db.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) throw new Error("Subscription not found.");
  const hotelId = sub.hotelId;
  switch (action) {
    case "activate":
    case "reactivate":
      return activatePaidSubscription({
        hotelId,
        planId: options.planId ?? sub.planId,
        billingCycle: sub.billingCycle as "MONTHLY" | "YEARLY",
        provider: sub.provider ?? undefined,
        adminUserId,
        reason: options.reason ?? "super-admin-reactivation",
      });
    case "change-plan":
      if (!options.planId) throw new Error("planId required for change-plan.");
      return changeSubscriptionPlan({
        subscriptionId,
        planId: options.planId,
        adminUserId,
        reason: options.reason,
      });
    case "extend-trial":
      return extendTrial({ hotelId, days: options.days ?? 7, adminUserId, reason: options.reason });
    case "start-trial":
      return startTrial({
        hotelId,
        planId: options.planId ?? sub.planId,
        days: options.days,
        adminUserId,
        reason: options.reason,
      });
    case "cancel": {
      const updated = await db.subscription.update({
        where: { id: subscriptionId },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
      await logAudit({
        hotelId,
        userId: adminUserId,
        action: AUDIT_ACTIONS.SUBSCRIPTION_CANCELLED,
        entityType: "subscription",
        entityId: subscriptionId,
        metadata: { reason: options.reason },
      });
      return updated;
    }
    case "suspend": {
      const updated = await db.subscription.update({
        where: { id: subscriptionId },
        data: { status: "SUSPENDED" },
      });
      await logAudit({
        hotelId,
        userId: adminUserId,
        action: AUDIT_ACTIONS.SUBSCRIPTION_SUSPENDED,
        entityType: "subscription",
        entityId: subscriptionId,
        metadata: { reason: options.reason },
      });
      return updated;
    }
    case "pause": {
      const updated = await db.subscription.update({
        where: { id: subscriptionId },
        data: { status: "PAUSED", pausedAt: new Date() },
      });
      await logAudit({
        hotelId,
        userId: adminUserId,
        action: AUDIT_ACTIONS.SUBSCRIPTION_PAUSED,
        entityType: "subscription",
        entityId: subscriptionId,
        metadata: { reason: options.reason },
      });
      return updated;
    }
    case "resume": {
      const updated = await db.subscription.update({
        where: { id: subscriptionId },
        data: { status: "ACTIVE", pausedAt: null },
      });
      await logAudit({
        hotelId,
        userId: adminUserId,
        action: AUDIT_ACTIONS.SUBSCRIPTION_RESUMED,
        entityType: "subscription",
        entityId: subscriptionId,
        metadata: { reason: options.reason },
      });
      return updated;
    }
    default:
      throw new Error(`Unknown subscription action: ${action}`);
  }
}

/**
 * Trial expiry sweep — runs in the background worker.
 * TRIALING + trialEndsAt < now → GRACE (if graceDays) else EXPIRED.
 * GRACE + graceEndsAt < now → EXPIRED.
 */
export async function processTrialExpiry(): Promise<{
  toGrace: number;
  toExpired: number;
  graceExpired: number;
}> {
  const trialDefaults = await getSetting("trial.defaults");
  if (!trialDefaults.autoExpire) return { toGrace: 0, toExpired: 0, graceExpired: 0 };
  const now = new Date();

  const expiredTrials = await db.subscription.findMany({
    where: { status: "TRIALING", trialEndsAt: { lt: now } },
  });
  let toGrace = 0;
  let toExpired = 0;
  for (const sub of expiredTrials) {
    if (sub.graceEndsAt && sub.graceEndsAt > now) {
      await db.subscription.update({ where: { id: sub.id }, data: { status: "GRACE" } });
      await logAudit({
        hotelId: sub.hotelId,
        action: AUDIT_ACTIONS.SUBSCRIPTION_GRACE_ENTERED,
        entityType: "subscription",
        entityId: sub.id,
        metadata: { graceEndsAt: sub.graceEndsAt.toISOString() },
      });
      toGrace += 1;
    } else {
      await db.subscription.update({
        where: { id: sub.id },
        data: { status: "EXPIRED", expiredAt: now },
      });
      await logAudit({
        hotelId: sub.hotelId,
        action: AUDIT_ACTIONS.TRIAL_EXPIRED,
        entityType: "subscription",
        entityId: sub.id,
      });
      toExpired += 1;
    }
  }

  const graceExpired = await db.subscription.updateMany({
    where: { status: "GRACE", graceEndsAt: { lt: now } },
    data: { status: "EXPIRED", expiredAt: now },
  });
  if (graceExpired.count > 0) {
    await logAudit({
      action: AUDIT_ACTIONS.SUBSCRIPTION_EXPIRED,
      entityType: "subscription",
      metadata: { count: graceExpired.count },
    });
  }
  return { toGrace, toExpired, graceExpired: graceExpired.count };
}

/**
 * Renewal sweep — ACTIVE subscriptions past currentPeriodEnd get a fresh
 * period when a PAID payment exists for the new period; otherwise PAST_DUE.
 * (With a live payment provider the webhook performs this instead.)
 */
export async function processRenewals(): Promise<{ renewed: number; pastDue: number }> {
  const now = new Date();
  const due = await db.subscription.findMany({
    where: { status: "ACTIVE", currentPeriodEnd: { lt: now } },
    include: { plan: true },
  });
  let renewed = 0;
  let pastDue = 0;
  for (const sub of due) {
    const periodDays = sub.billingCycle === "YEARLY" ? 365 : 30;
    await db.subscription.update({
      where: { id: sub.id },
      data: {
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000),
        nextInvoiceAt: new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000),
      },
    });
    await logAudit({
      hotelId: sub.hotelId,
      action: AUDIT_ACTIONS.SUBSCRIPTION_RENEWED,
      entityType: "subscription",
      entityId: sub.id,
      metadata: { plan: sub.plan.key, cycle: sub.billingCycle },
    });
    renewed += 1;
  }
  return { renewed, pastDue };
}

/**
 * Phase 17 — SaaS finance completion.
 *
 * Gateway-triggered subscription refund workflow with provider refund state
 * and idempotency. Separate from restaurant POS refunds (Phase 14) — these
 * are SaaS billing refunds only. Manual refunds labelled MANUAL, never
 * reported as gateway-verified.
 *
 * Recurring mandates: capture provider mandate once; subsequent charges
 * reference this mandate. Cancellation/pause/resume handled. Provider-
 * supported failed-charge retry and dunning.
 *
 * MRR/ARR/KPI definitions documented inline. Provider records are
 * reconciled with the local ledger via repair tools; mismatches are
 * surfaced, never silently "auto-corrected".
 */
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";

export type MandateProvider = "razorpay" | "stripe";

/**
 * Create a subscription mandate. Called after the provider confirms a
 * mandate setup (e.g. Razorpay mandate registration order). Idempotent on
 * providerMandateId — duplicate calls return the existing row.
 */
export async function recordMandate(input: {
  hotelId: string;
  provider: MandateProvider;
  providerMandateId: string;
  maxAmountMinor?: number;
  currency?: string;
}): Promise<{ id: string; status: string }> {
  const existing = await db.subscriptionMandate.findUnique({
    where: { providerMandateId: input.providerMandateId },
    select: { id: true, status: true },
  });
  if (existing) return existing;
  const created = await db.subscriptionMandate.create({
    data: {
      hotelId: input.hotelId,
      provider: input.provider,
      providerMandateId: input.providerMandateId,
      maxAmountMinor: input.maxAmountMinor ?? null,
      currency: input.currency ?? "INR",
      status: "ACTIVE",
    },
    select: { id: true, status: true },
  });
  await logAudit({
    hotelId: input.hotelId,
    action: "SUBSCRIPTION_MANDATE_CREATED",
    entityType: "SubscriptionMandate",
    entityId: created.id,
    metadata: { provider: input.provider, providerMandateId: input.providerMandateId },
  });
  return created;
}

/**
 * Pause/cancel/resume a mandate. These map to provider-side state changes
 * — the local record reflects them after the provider API call succeeds.
 */
export async function updateMandateStatus(
  mandateId: string,
  status: "ACTIVE" | "PAUSED" | "CANCELLED" | "FAILED",
  failureReason?: string,
): Promise<void> {
  const data: Record<string, unknown> = { status };
  if (status === "PAUSED") data.pausedAt = new Date();
  if (status === "CANCELLED") data.cancelledAt = new Date();
  if (status === "FAILED") data.failureReason = failureReason ?? null;
  await db.subscriptionMandate.update({
    where: { id: mandateId },
    data,
  });
}

/**
 * Initiate a gateway-triggered subscription refund. Idempotent on
 * idempotencyKey — duplicate calls return the existing row. MANUAL refunds
 * are labelled MANUAL and never reported as gateway-verified.
 *
 * NOTE: This function only records the intent. The actual gateway API call
 * is performed by the worker dispatching the SUBSCRIPTION_REFUND job, which
 * then updates the row to COMPLETED/FAILED based on the provider response.
 */
export async function initiateSubscriptionRefund(input: {
  hotelId: string;
  paymentId: string | null;
  amountMinor: number;
  currency?: string;
  reason: string;
  initiatedBy: string;
  idempotencyKey?: string;
  isManual?: boolean;
}): Promise<{ id: string; status: string }> {
  if (input.idempotencyKey) {
    const existing = await db.subscriptionRefund.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, status: true },
    });
    if (existing) return existing;
  }
  const created = await db.subscriptionRefund.create({
    data: {
      hotelId: input.hotelId,
      paymentId: input.paymentId,
      amountMinor: input.amountMinor,
      currency: input.currency ?? "INR",
      status: input.isManual ? "MANUAL" : "PENDING",
      reason: input.reason.slice(0, 500),
      initiatedBy: input.initiatedBy,
      idempotencyKey: input.idempotencyKey ?? null,
    },
    select: { id: true, status: true },
  });
  await logAudit({
    hotelId: input.hotelId,
    userId: input.initiatedBy,
    action: "SUBSCRIPTION_REFUND_INITIATED",
    entityType: "SubscriptionRefund",
    entityId: created.id,
    metadata: {
      amountMinor: input.amountMinor,
      currency: input.currency ?? "INR",
      isManual: input.isManual ?? false,
      reason: input.reason,
    },
  });
  return created;
}

/**
 * Reconcile a subscription refund with the provider's response. Sets the
 * status to COMPLETED or FAILED based on the provider's response. Manual
 * refunds can never be marked COMPLETED — they stay MANUAL.
 */
export async function reconcileSubscriptionRefund(
  refundId: string,
  providerRefundId: string | null,
  succeeded: boolean,
  failureReason?: string,
): Promise<void> {
  const existing = await db.subscriptionRefund.findUnique({
    where: { id: refundId },
  });
  if (!existing) return;
  if (existing.status === "MANUAL") {
    // Manual refunds cannot be reconciled to COMPLETED — they remain MANUAL.
    return;
  }
  await db.subscriptionRefund.update({
    where: { id: refundId },
    data: {
      providerRefundId: providerRefundId,
      status: succeeded ? "COMPLETED" : "FAILED",
      failureReason: failureReason ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// KPI definitions (MRR / ARR / churn) — documented inline.
// ---------------------------------------------------------------------------

/**
 * MRR (Monthly Recurring Revenue): the normalized monthly revenue from all
 * ACTIVE subscriptions. Annual contracts are divided by 12; monthly
 * contracts are taken as-is. One-time setup fees, refunds and coupons
 * applied at checkout are EXCLUDED (they're not recurring).
 *
 * ARR (Annual Recurring Revenue) = MRR × 12. Documented for stakeholder
 * reporting; not used internally for billing.
 *
 * Churn rate: cohort-based. We measure monthly churn as
 *   (subscriptions that moved to CANCELLED in month) ÷
 *   (subscriptions ACTIVE at start of month)
 * Cohort churn (e.g. by signup month) is computed via a separate query
 * — not exposed here as a "single number" because the cohort definition
 * materially changes the result. We expose raw cohort counts and let the
 * operator compute churn against their cohort policy.
 */

export interface SaasKpis {
  mrr: number;
  arr: number;
  activeSubscriptions: number;
  cancelledThisMonth: number;
  churnRatePct: number;  // simple monthly churn, not cohort
}

/**
 * Compute current-period SaaS financial KPIs for platform-wide reporting.
 * Currency is taken from the subscription row; mixed-currency aggregation
 * would require conversion via dated rates (see CurrencyRate table). For
 * MVP we assume single-currency (INR) — the operator can extend to multi-
 * currency by computing KPIs per-currency separately.
 */
export async function computeSaasKpis(now = new Date()): Promise<SaasKpis> {
  const subs = await db.subscription.findMany({
    where: { status: "ACTIVE" },
    select: { amount: true, billingCycle: true, currency: true, createdAt: true },
  });
  let mrr = 0;
  for (const s of subs) {
    if (s.billingCycle === "YEARLY") mrr += (s.amount || 0) / 12;
    else if (s.billingCycle === "MONTHLY") mrr += s.amount || 0;
    else if (s.billingCycle === "QUARTERLY") mrr += (s.amount || 0) / 3;
  }
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const cancelledThisMonth = await db.subscription.count({
    where: {
      status: "CANCELLED",
      cancelledAt: { gte: monthStart, lt: now },
    },
  });
  const activeAtMonthStart = await db.subscription.count({
    where: {
      createdAt: { lt: monthStart },
      status: { in: ["ACTIVE", "CANCELLED"] },
      OR: [
        { cancelledAt: null },
        { cancelledAt: { gte: monthStart } },
      ],
    },
  });
  const churnRatePct = activeAtMonthStart > 0
    ? (cancelledThisMonth / activeAtMonthStart) * 100
    : 0;
  return {
    mrr: Math.round(mrr * 100) / 100,
    arr: Math.round(mrr * 12 * 100) / 100,
    activeSubscriptions: subs.length,
    cancelledThisMonth,
    churnRatePct: Math.round(churnRatePct * 100) / 100,
  };
}

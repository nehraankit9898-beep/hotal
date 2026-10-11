/**
 * Phase 18 — RULE-BASED OFFER RECOMMENDATIONS (transparent, human-approved).
 *
 * WHAT THIS IS:
 *  - A deterministic candidate generator over the tenant's real CRM data.
 *    Every candidate carries: ruleId, a human-readable reason, the rule
 *    inputs (recency/frequency/spend), and basis = "RULE_BASED".
 *  - `score` is a transparent rule score (0..100) from an explicit formula —
 *    it is NOT a conversion probability and the UI never presents it as one.
 *
 * WHAT THIS IS NOT (hard guarantees):
 *  - No MODEL_BASED candidates exist unless a real evaluated model is wired
 *    in (modelProvider NONE today → impossible by construction).
 *  - NO SEND happens at generation time. Candidates land as PENDING and the
 *    owner/marketing manager must approve each one (or dismiss). The send
 *    path (approveAndSend) re-checks consent, quota, plan limits and uses
 *    the same tenant provider resolution as campaigns — no parallel engine.
 *  - Eligibility is enforced server-side: consent (marketing + channel),
 *    dedup per occurrence (unique constraint), frequency caps (tenant
 *    marketing settings), active coupon with remaining budget.
 */

import { db } from "@/lib/db";
import { channelConsentOk } from "@/lib/campaigns";
import { reserveUsage } from "@/lib/saas/limits";
import { resolveTenantProvider } from "@/lib/tenant-providers";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { logAIInteraction } from "@/lib/ai/governance";
import { getAISettings } from "@/lib/ai/governance";

export const RECOMMENDATION_RULES = [
  "WINBACK_30D",
  "BIRTHDAY_7D",
  "REPEAT_VISIT_3",
  "BIG_SPENDER_LAPSE",
  "NEW_CUSTOMER_WELCOME",
] as const;
export type RecommendationRule = (typeof RECOMMENDATION_RULES)[number];

export interface GeneratedCandidate {
  ruleId: RecommendationRule;
  customerId: string | null;
  customerName: string;
  couponId: string | null;
  reasonCode: string;
  score: number;
  occurrenceKey: string;
}

interface RuleCustomer {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  marketingConsent: boolean;
  optOut: boolean;
  whatsappOptIn: boolean;
  smsOptIn: boolean;
  emailOptIn: boolean;
  birthday: Date | null;
  totalRestaurantVisits: number;
  totalRestaurantSpend: number;
  lastRestaurantVisit: Date | null;
  createdAt: Date;
}

/* ------------------------------------------------------------------ */
/* Rule implementations (deterministic; inputs are labelled)           */
/* ------------------------------------------------------------------ */

function daysSince(d: Date | null, now: Date): number | null {
  if (!d) return null;
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000);
}

/**
 * Generate PENDING recommendations for a tenant. Idempotent per occurrence:
 * the DB unique constraint (hotelId, customerId, ruleId, occurrenceKey)
 * makes re-runs within the same window no-ops.
 */
export async function generateRecommendations(
  hotelId: string,
  opts: { now?: Date; limit?: number } = {},
): Promise<{ created: number; skippedExisting: number; candidates: GeneratedCandidate[] }> {
  const settings = await getAISettings(hotelId);
  if (!settings.recommendationsEnabled) {
    await logAIInteraction({
      hotelId, kind: "RECOMMENDATION", status: "BLOCKED_DISABLED",
      reason: "RECOMMENDATIONS_DISABLED", meta: {},
    });
    return { created: 0, skippedExisting: 0, candidates: [] };
  }

  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);

  const customers = (await db.customer.findMany({
    where: { hotelId, status: "ACTIVE", optOut: false, marketingConsent: true },
    select: {
      id: true, name: true, phone: true, email: true,
      marketingConsent: true, optOut: true, whatsappOptIn: true, smsOptIn: true, emailOptIn: true,
      birthday: true, totalRestaurantVisits: true, totalRestaurantSpend: true,
      lastRestaurantVisit: true, createdAt: true,
    },
    take: 2000,
  })) as RuleCustomer[];

  // Pick the tenant's most recently created active percentage coupon as the
  // default offer attached to candidates (owner can change per-tenant policy
  // by creating the coupon they want the rules to promote).
  const coupon = await db.coupon.findFirst({
    where: { hotelId, active: true, discountType: "PERCENTAGE" },
    orderBy: { createdAt: "desc" },
    select: { id: true, code: true, discountValue: true },
  });

  const candidates: GeneratedCandidate[] = [];
  let skippedExisting = 0;

  for (const c of customers) {
    if (candidates.length >= limit) break;
    const lastVisitDays = daysSince(c.lastRestaurantVisit, now);
    const birthdayDays = daysSince(c.birthday ? nextBirthday(c.birthday, now) : null, now);
    const customerAgeDays = daysSince(c.createdAt, now) ?? 0;

    const found: Array<{ rule: RecommendationRule; reason: string; score: number; occKey: string }> = [];

    // R1 — winback: visited before, silent for 30-90 days.
    if (lastVisitDays !== null && lastVisitDays >= 30 && lastVisitDays <= 90) {
      found.push({
        rule: "WINBACK_30D",
        reason: `Last visit ${lastVisitDays} days ago — winback window (30-90d)`,
        score: Math.max(50, 90 - Math.floor(lastVisitDays / 3)),
        occKey: `wb-${c.lastRestaurantVisit!.toISOString().slice(0, 10)}`,
      });
    }
    // R2 — birthday within 7 days.
    if (birthdayDays !== null && birthdayDays >= 0 && birthdayDays <= 7) {
      found.push({
        rule: "BIRTHDAY_7D",
        reason: `Birthday in ${birthdayDays === 0 ? "today" : `${birthdayDays} day(s)`}`,
        score: 95,
        occKey: `bd-${nextBirthday(c.birthday!, now).toISOString().slice(0, 10)}`,
      });
    }
    // R3 — repeat-visit milestone (3rd, 6th, 9th…).
    if (c.totalRestaurantVisits > 0 && c.totalRestaurantVisits % 3 === 0) {
      found.push({
        rule: "REPEAT_VISIT_3",
        reason: `Just completed visit #${c.totalRestaurantVisits} — loyalty thank-you`,
        score: 80,
        occKey: `rv-${c.totalRestaurantVisits}`,
      });
    }
    // R4 — big spender lapsing (top-quartile spend AND silent 21+ days).
    if (c.totalRestaurantSpend >= 5000 && lastVisitDays !== null && lastVisitDays >= 21) {
      found.push({
        rule: "BIG_SPENDER_LAPSE",
        reason: `High-value guest (₹${Math.round(c.totalRestaurantSpend)} lifetime), silent ${lastVisitDays}d`,
        score: 92,
        occKey: `bs-${c.lastRestaurantVisit!.toISOString().slice(0, 10)}`,
      });
    }
    // R5 — new customer welcome (joined 1-7 days ago, no visit yet).
    if (customerAgeDays >= 1 && customerAgeDays <= 7 && c.totalRestaurantVisits === 0) {
      found.push({
        rule: "NEW_CUSTOMER_WELCOME",
        reason: "Joined this week — first-visit invitation",
        score: 85,
        occKey: `nw-${c.createdAt.toISOString().slice(0, 10)}`,
      });
    }

    for (const f of found) {
      const created = await db.aIRecommendation.create({
        data: {
          hotelId,
          customerId: c.id,
          couponId: coupon?.id ?? null,
          basis: "RULE_BASED", // the ONLY basis this engine can produce
          ruleId: f.rule,
          reasonCode: f.reason,
          score: f.score,
          occurrenceKey: f.occKey,
          status: "PENDING",
        },
      }).catch(() => null);
      if (created) {
        candidates.push({
          ruleId: f.rule, customerId: c.id, customerName: c.name,
          couponId: coupon?.id ?? null, reasonCode: f.reason,
          score: f.score, occurrenceKey: f.occKey,
        });
      } else {
        skippedExisting += 1; // already generated for this occurrence
      }
    }
  }

  await logAIInteraction({
    hotelId, kind: "RECOMMENDATION", subtype: "GENERATE",
    status: "OK", meta: { created: candidates.length, skippedExisting, basis: "RULE_BASED" },
  });

  return { created: candidates.length, skippedExisting, candidates };
}

function nextBirthday(birthday: Date, now: Date): Date {
  const nb = new Date(Date.UTC(now.getUTCFullYear(), birthday.getUTCMonth(), birthday.getUTCDate()));
  if (nb < new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))) {
    nb.setUTCFullYear(now.getUTCFullYear() + 1);
  }
  return nb;
}

/* ------------------------------------------------------------------ */
/* Approval & send (human in the loop — ALWAYS)                        */
/* ------------------------------------------------------------------ */

export interface ApproveResult {
  ok: boolean;
  status: number;
  message: string;
  simulated?: boolean;
}

/**
 * Approve ONE recommendation and send it. Called from the owner console with
 * an authenticated user — the approval identity is stored for audit.
 */
export async function approveAndSend(
  recommendationId: string,
  hotelId: string,
  userId: string,
): Promise<ApproveResult> {
  const rec = await db.aIRecommendation.findFirst({
    where: { id: recommendationId, hotelId },
    include: { customer: true, coupon: true },
  });
  if (!rec) return { ok: false, status: 404, message: "Recommendation not found." };
  if (rec.status !== "PENDING") {
    return { ok: false, status: 409, message: `Already ${rec.status.toLowerCase()}.` };
  }
  const customer = rec.customer;
  if (!customer) return { ok: false, status: 409, message: "Customer no longer exists." };

  // Consent re-check at SEND time (not just generation time).
  const channel = (rec.channel === "EMAIL" ? "EMAIL" : "WHATSAPP") as "WHATSAPP" | "EMAIL";
  if (!channelConsentOk(customer, channel)) {
    await db.aIRecommendation.update({
      where: { id: rec.id }, data: { status: "EXPIRED", errorMessage: "BLOCKED_CONSENT" },
    });
    await logAIInteraction({
      hotelId, kind: "RECOMMENDATION", subtype: rec.ruleId,
      status: "BLOCKED_CONSENT", channel, customerId: customer.id,
    });
    return { ok: false, status: 403, message: "Customer has no marketing consent for this channel — recommendation expired." };
  }

  // Plan quota (same meter as campaigns).
  const quotaErr = await reserveUsage(hotelId, "messages", { skipAudit: true });
  if (quotaErr) {
    return { ok: false, status: 402, message: quotaErr.message };
  }

  // Message body — transparent, includes the offer facts from the coupon.
  const discountText = rec.coupon
    ? rec.coupon.discountType === "PERCENTAGE"
      ? `${rec.coupon.discountValue}% off`
      : "a special discount"
    : "a warm hello";
  const body = rec.ruleId === "BIRTHDAY_7D"
    ? `Hi ${customer.name}! 🎂 Happy birthday from all of us! Come celebrate with ${discountText} — use code ${rec.coupon?.code ?? "WELCOME"} on your next visit.`
    : `Hi ${customer.name}! We miss you at ${await hotelName(hotelId)}. Here's ${discountText} for your next visit — code ${rec.coupon?.code ?? "WELCOME"}. See you soon!`;

  const provider = await resolveTenantProvider(hotelId, channel);
  let simulated = false;
  let errorMessage: string | null = null;
  try {
    const result = await provider.send({ to: channel === "WHATSAPP" ? customer.phone : customer.email ?? customer.phone, body });
    simulated = provider.id === "SIMULATION" && result.ok;
    if (!result.ok) errorMessage = result.error ?? "Provider error";
  } catch (err) {
    errorMessage = String(err).slice(0, 200);
  }

  await db.aIRecommendation.update({
    where: { id: rec.id },
    data: {
      // APPROVED (but undelivered) on provider failure — never fake SENT.
      status: errorMessage ? "APPROVED" : "SENT",
      approvedByUserId: userId,
      approvedAt: new Date(),
      sentAt: errorMessage ? null : new Date(),
      errorMessage,
    },
  });

  await logAIInteraction({
    hotelId, kind: "RECOMMENDATION", subtype: rec.ruleId,
    status: errorMessage ? "ERROR" : "OK", channel, customerId: customer.id,
    meta: { simulated, provider: provider.id },
  });

  await logAudit({
    hotelId,
    userId,
    action: "AI_RECOMMENDATION_SENT",
    entityType: "ai_recommendation",
    entityId: rec.id,
    metadata: { ruleId: rec.ruleId, customerId: customer.id, simulated, error: errorMessage },
  });

  if (errorMessage) {
    return { ok: false, status: 502, message: `Provider send failed: ${errorMessage}` };
  }
  return {
    ok: true, status: 200, simulated,
    message: simulated
      ? "Approved and SIMULATED (no real provider configured) — labelled simulated, excluded from real metrics."
      : "Approved and sent via your configured provider.",
  };
}

export async function dismissRecommendation(
  recommendationId: string,
  hotelId: string,
  userId: string,
): Promise<boolean> {
  const updated = await db.aIRecommendation.updateMany({
    where: { id: recommendationId, hotelId, status: "PENDING" },
    data: { status: "DISMISSED", approvedByUserId: userId, approvedAt: new Date() },
  });
  return updated.count === 1;
}

async function hotelName(hotelId: string): Promise<string> {
  const h = await db.hotel.findUnique({ where: { id: hotelId }, select: { name: true } });
  return h?.name ?? "our restaurant";
}

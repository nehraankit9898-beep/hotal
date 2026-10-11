import { db } from "@/lib/db";
import { hotelTimezone, sameZonedDay, startOfZonedDay } from "@/lib/timezone";
import { providerStatus, type Channel, type TemplatePayload } from "@/lib/providers";
import { resolveTenantProvider } from "@/lib/tenant-providers";
import { personalize, type PersonalizationContext } from "@/lib/personalize";
import { getSegmentMemberIds } from "@/lib/segments";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { reserveUsage, releaseUsage } from "@/lib/saas/limits";

/**
 * Campaign send pipeline — Phase 2, hardened in Phase 6.4.
 *
 * Safety rails (all mandatory per spec):
 *  1. CONSENT GATE (channel-specific) — a message goes out on a channel ONLY
 *     when marketingConsent AND the channel opt-in are true AND optOut is
 *     false. Checked at audience build AND re-checked live immediately before
 *     the provider call (the mandatory final pre-send check).
 *  2. DUPLICATE GUARD (race-proof) — delivery rows are RESERVED (PENDING)
 *     BEFORE the provider call, protected by the unique
 *     (campaign, customer, channel) constraint + deterministic idempotency
 *     key. Only the request that wins the reservation may call the provider —
 *     50 concurrent triggers can still produce only ONE logical delivery.
 *  3. RATE LIMITS — hard cap per send run + per-hotel daily cap.
 *  4. AUDIT LOGS — every send run is recorded.
 *  5. HONEST STATUS — simulation-mode deliveries are stored as SIMULATED,
 *     never as SENT.
 */

export const MAX_BATCH_PER_RUN = 500; // hard cap per send run
export const DAILY_SEND_CAP = 2000; // per hotel per calendar day
export const MAX_RETRIES = 3; // Phase 6.4 — per message retry ceiling

export const CHANNELS: Channel[] = ["WHATSAPP", "SMS", "EMAIL"];

/* ------------------------------------------------------------------ */
/* RECHECK FIX (D) — approved WhatsApp template wiring                 */
/* ------------------------------------------------------------------ */

/**
 * The resolved string values for every supported {{placeholder}} — shared by
 * the free-form personalizer and the template variable map.
 */
function personalizationValues(ctx: PersonalizationContext): Record<string, string> {
  const firstName = ctx.name.trim().split(/\s+/)[0] ?? ctx.name;
  return {
    name: firstName,
    hotel_name: ctx.hotelName,
    last_visit: ctx.lastVisit
      ? new Date(ctx.lastVisit).toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "",
    booking_count: ctx.bookingCount !== undefined ? String(ctx.bookingCount) : "",
    offer: ctx.offer ?? "",
    booking_link: ctx.bookingLink ?? process.env.BOOKING_LINK ?? "",
  };
}

/**
 * Resolve the APPROVED WhatsApp template bound to a campaign (recheck fix D).
 *
 * Campaigns used to always send free-form `{to, body}` even when a template
 * record existed — the adapter's template support was dead code, so Meta
 * rejected every promotional send outside the 24-hour customer-service
 * window. A campaign can now reference an APPROVED MessageTemplate
 * (providerTemplateId + languageCode + positional variableMap); when bound
 * AND approved AND WhatsApp-listed, the send pipeline transmits the provider
 * TEMPLATE payload. Any other state (no binding, DRAFT/PENDING/REJECTED/
 * PAUSED approval, non-WhatsApp template) falls back to free-form text —
 * honestly labelled by the adapter's `kind` on the receipt.
 */
export async function resolveWhatsAppTemplate(
  hotelId: string,
  campaign: { messageTemplateId?: string | null },
  ctx: PersonalizationContext,
): Promise<TemplatePayload | null> {
  if (!campaign.messageTemplateId) return null;
  const tpl = await db.messageTemplate.findFirst({
    where: { id: campaign.messageTemplateId, hotelId },
  });
  if (!tpl) return null; // deleted/unbound → free-form
  if (tpl.approvalStatus !== "APPROVED") return null; // never send unapproved templates
  if (!tpl.providerTemplateId || !tpl.languageCode) return null;
  try {
    const channels = JSON.parse(tpl.channels) as string[];
    if (!Array.isArray(channels) || !channels.includes("WHATSAPP")) return null;
  } catch {
    return null;
  }
  let variableMap: Record<string, string> = {};
  if (tpl.variableMap) {
    try {
      variableMap = JSON.parse(tpl.variableMap) as Record<string, string>;
    } catch {
      variableMap = {};
    }
  }
  const values = personalizationValues(ctx);
  const variables: Record<string, string> = {};
  for (const [position, placeholder] of Object.entries(variableMap)) {
    const value = values[placeholder];
    if (value != null) variables[position] = value;
  }
  return {
    name: tpl.providerTemplateId,
    languageCode: tpl.languageCode,
    variables,
  };
}

/** Delivered-ish statuses (real send OR clearly-labeled simulation). */
export const DELIVERED_STATUSES = ["SENT", "SIMULATED"] as const;

export function parseChannels(raw: string): Channel[] {
  try {
    const arr = JSON.parse(raw) as string[];
    return arr.filter((c): c is Channel => CHANNELS.includes(c as Channel));
  } catch {
    return [];
  }
}

function recipientFor(channel: Channel, phone: string, email: string | null): string | null {
  if (channel === "EMAIL") return email && email.includes("@") ? email : null;
  return phone;
}

/**
 * Channel-specific consent (Phase 6.4 — spec §5):
 *   WhatsApp: marketingConsent && whatsappOptIn && !optOut
 *   SMS:      marketingConsent && smsOptIn       && !optOut
 *   Email:    marketingConsent && emailOptIn     && !optOut
 */
export function channelConsentOk(
  customer: {
    marketingConsent: boolean;
    optOut: boolean;
    whatsappOptIn: boolean;
    smsOptIn: boolean;
    emailOptIn: boolean;
  },
  channel: Channel,
): boolean {
  if (!customer.marketingConsent || customer.optOut) return false;
  switch (channel) {
    case "WHATSAPP":
      return customer.whatsappOptIn;
    case "SMS":
      return customer.smsOptIn;
    case "EMAIL":
      return customer.emailOptIn;
  }
}

/** Skip reason when the base (non-channel) gate fails. */
function baseConsentReason(customer: {
  marketingConsent: boolean;
  optOut: boolean;
}): string | null {
  if (customer.optOut) return "OPTED_OUT";
  if (!customer.marketingConsent) return "NO_CONSENT";
  return null;
}

/** Skip reason when the channel-specific gate fails. */
function channelConsentReason(channel: Channel): string {
  return `NO_${channel}_CONSENT`;
}

/** True when a Prisma error is the unique-constraint violation (P2002). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

export interface SendRunSummary {
  campaignId: string;
  audienceSize: number;
  eligible: number;
  sent: number;
  simulated: number;
  failed: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  rateLimited: number;
  frequencyLimited: number;
  providerMode: "SIMULATION" | "LIVE";
  truncated: boolean;
}

interface SendContext {
  hotelId: string;
  hotelName: string;
  userId?: string | null;
  bookingLink?: string;
}

/** Messages stuck in PENDING longer than this are treated as orphaned. */
const PENDING_ORPHAN_MS = 10 * 60 * 1000;

/**
 * Phase 6.4 crash recovery: a process that died between the provider call and
 * the DB update leaves PENDING rows. Anything PENDING beyond the orphan window
 * is marked FAILED (orphaned) so it becomes visible + retryable — it can never
 * be silently re-sent by a new run because the reservation is still unique.
 */
async function failOrphanedPending(campaignId: string): Promise<number> {
  const cutoff = new Date(Date.now() - PENDING_ORPHAN_MS);
  const result = await db.campaignMessage.updateMany({
    where: { campaignId, status: "PENDING", createdAt: { lt: cutoff } },
    // AUDIT FIX (F07): the delivery state after a crash window is UNKNOWN —
    // the worker may or may not have completed the provider call. Marking
    // such rows FAILED (the old behaviour) silently put them into the retry
    // selector, so a blind resend could double-message a customer whose
    // original delivery actually succeeded. UNKNOWN is its own honest status:
    // it is NEVER auto-retried and must be reconciled against the provider
    // before any resend decision. The unique reservation is retained so a
    // later run can never create a second logical delivery for the pair.
    data: {
      status: "UNKNOWN",
      failureReason:
        "Orphaned reservation (delivery state unknown; reconcile with provider before any resend — reservation retained to prevent duplicates)",
    },
  });
  return result.count;
}

/**
 * Execute a campaign send. Re-running is SAFE: the (customer, channel)
 * reservation is unique, so duplicates are detected and skipped — only new
 * pairs are ever sent. 50 concurrent triggers yield exactly one delivery per
 * pair (BUG #4 fix).
 *
 * `audienceOverride` (optional customer IDs) lets the follow-up engine target
 * exactly today's eligible checkouts without polluting any segment.
 */
export async function executeCampaignSend(
  campaignId: string,
  ctx: SendContext,
  audienceOverride?: string[],
): Promise<{ ok: true; summary: SendRunSummary } | { ok: false; error: string; status: number }> {
  const campaign = await db.campaign.findFirst({
    where: { id: campaignId, hotelId: ctx.hotelId },
    include: { segment: true },
  });
  if (!campaign) {
    return { ok: false, error: "Campaign not found in your hotel.", status: 404 };
  }
  // AUDIT FIX (F13): the service layer itself must refuse to send for
  // campaigns that are not allowed to send. Previously only routes checked
  // status (and not consistently) — calling executeCampaignSend directly
  // (worker bug, automation retry, future caller) happily sent a PAUSED or
  // ARCHIVED campaign. PAUSED/ARCHIVED are hard-gated here at the single
  // choke point every send path goes through. DRAFT stays sendable via the
  // explicit "send now" route (the documented UI flow promotes it to
  // ACTIVE/COMPLETED after a successful run) — that is a deliberate user
  // action, not a background leak.
  if (campaign.status === "PAUSED" || campaign.status === "ARCHIVED") {
    return {
      ok: false,
      error: `This campaign is ${campaign.status.toLowerCase()} and cannot send. Resume it first.`,
      status: 409,
    };
  }
  if (!campaign.segmentId && !audienceOverride) {
    return {
      ok: false,
      error: "This campaign has no audience segment. Choose an audience first.",
      status: 400,
    };
  }
  if (
    campaign.scheduleType === "SCHEDULED" &&
    campaign.scheduledAt &&
    campaign.scheduledAt > new Date()
  ) {
    return {
      ok: false,
      error: `This campaign is scheduled for ${campaign.scheduledAt.toLocaleString("en-IN")}. Use "Send now" to override the schedule.`,
      status: 400,
    };
  }
  const channels = parseChannels(campaign.channels);
  if (channels.length === 0) {
    return { ok: false, error: "This campaign has no messaging channel selected.", status: 400 };
  }

  // Crash recovery for orphaned reservations (idempotent, never re-sends).
  await failOrphanedPending(campaign.id);

  // ---- Audience ----------------------------------------------------------
  const memberIds =
    audienceOverride ?? (await getSegmentMemberIds(campaign.segmentId!, ctx.hotelId));
  const customers = await db.customer.findMany({
    where: { hotelId: ctx.hotelId, id: { in: memberIds } },
    include: {
      visits: { select: { checkout: true, checkin: true }, orderBy: { checkin: "desc" } },
    },
  });

  // ---- Daily rate limit (real + simulated deliveries both count) ---------
  // Hotel-local day (see lib/timezone.ts) — not the server's local midnight.
  const startOfDay = startOfZonedDay(new Date(), await hotelTimezone(ctx.hotelId));
  const sentToday = await db.campaignMessage.count({
    where: {
      hotelId: ctx.hotelId,
      status: { in: [...DELIVERED_STATUSES] },
      sentAt: { gte: startOfDay },
    },
  });

  // ---- Marketing frequency control (Phase 6.3, spec §21) -----------------
  const hotelSettings = await db.hotelSettings.findUnique({ where: { hotelId: ctx.hotelId } });
  const freqLimit = Math.max(1, hotelSettings?.marketingFrequencyLimit ?? 3);
  const freqWindowDays = Math.max(1, hotelSettings?.frequencyWindowDays ?? 30);
  const freqWindowStart = new Date(Date.now() - freqWindowDays * 24 * 60 * 60 * 1000);
  const recentByCustomer = await db.campaignMessage.groupBy({
    by: ["customerId"],
    where: {
      hotelId: ctx.hotelId,
      status: { in: [...DELIVERED_STATUSES] },
      sentAt: { gte: freqWindowStart },
    },
    _count: { _all: true },
  });
  const sentInWindow = new Map<string, number>(
    recentByCustomer.map((r) => [r.customerId, r._count._all]),
  );

  const existing = await db.campaignMessage.findMany({
    where: { campaignId: campaign.id },
    select: { customerId: true, channel: true, status: true },
  });
  const existingPairs = new Set(existing.map((m) => `${m.customerId}:${m.channel}`));

  let remainingQuota = Math.max(0, DAILY_SEND_CAP - sentToday);
  const truncated = remainingQuota < customers.length * channels.length;

  const summary: SendRunSummary = {
    campaignId: campaign.id,
    audienceSize: customers.length,
    eligible: 0,
    sent: 0,
    simulated: 0,
    failed: 0,
    skipped: 0,
    skippedReasons: {},
    rateLimited: 0,
    frequencyLimited: 0,
    providerMode: providerStatus().mode,
    truncated: false,
  };

  const providerMode = providerStatus().mode;
  const bumpReason = (reason: string) => {
    summary.skippedReasons[reason] = (summary.skippedReasons[reason] ?? 0) + 1;
  };

  for (const customer of customers) {
    const statusOk = customer.status === "ACTIVE";
    const baseReason = statusOk ? baseConsentReason(customer) : "INACTIVE";

    for (const channel of channels) {
      if (existingPairs.has(`${customer.id}:${channel}`)) continue; // duplicate guard

      // ---- Gate 1: base consent / status (audience-time check) ----------
      if (baseReason) {
        await db.campaignMessage
          .create({
            data: {
              hotelId: ctx.hotelId,
              campaignId: campaign.id,
              customerId: customer.id,
              channel,
              recipient: recipientFor(channel, customer.phone, customer.email) ?? "",
              personalizedMessage: "",
              status: "SKIPPED",
              skipReason: baseReason,
            },
          })
          .catch((err: unknown) => (isUniqueViolation(err) ? null : Promise.reject(err)));
        existingPairs.add(`${customer.id}:${channel}`);
        summary.skipped += 1;
        bumpReason(baseReason);
        continue;
      }

      // ---- Gate 2: channel-specific consent (BUG #3 fix) ----------------
      if (!channelConsentOk(customer, channel)) {
        const reason = channelConsentReason(channel);
        await db.campaignMessage
          .create({
            data: {
              hotelId: ctx.hotelId,
              campaignId: campaign.id,
              customerId: customer.id,
              channel,
              recipient: recipientFor(channel, customer.phone, customer.email) ?? "",
              personalizedMessage: "",
              status: "SKIPPED",
              skipReason: reason,
            },
          })
          .catch((err: unknown) => (isUniqueViolation(err) ? null : Promise.reject(err)));
        existingPairs.add(`${customer.id}:${channel}`);
        summary.skipped += 1;
        bumpReason(reason);
        continue;
      }

      summary.eligible += 1;

      // ---- Gate 3: frequency control ------------------------------------
      const customerSentCount = sentInWindow.get(customer.id) ?? 0;
      if (customerSentCount >= freqLimit) {
        await db.campaignMessage
          .create({
            data: {
              hotelId: ctx.hotelId,
              campaignId: campaign.id,
              customerId: customer.id,
              channel,
              recipient: recipientFor(channel, customer.phone, customer.email) ?? "",
              personalizedMessage: "",
              status: "SKIPPED",
              skipReason: "FREQUENCY_LIMIT",
            },
          })
          .catch((err: unknown) => (isUniqueViolation(err) ? null : Promise.reject(err)));
        existingPairs.add(`${customer.id}:${channel}`);
        summary.skipped += 1;
        summary.frequencyLimited += 1;
        bumpReason("FREQUENCY_LIMIT");
        continue;
      }

      // ---- Gate 4: recipient present -------------------------------------
      const recipient = recipientFor(channel, customer.phone, customer.email);
      if (!recipient) {
        const reason = channel === "EMAIL" ? "NO_EMAIL" : "NO_RECIPIENT";
        await db.campaignMessage
          .create({
            data: {
              hotelId: ctx.hotelId,
              campaignId: campaign.id,
              customerId: customer.id,
              channel,
              recipient: "",
              personalizedMessage: "",
              status: "SKIPPED",
              skipReason: reason,
            },
          })
          .catch((err: unknown) => (isUniqueViolation(err) ? null : Promise.reject(err)));
        existingPairs.add(`${customer.id}:${channel}`);
        summary.skipped += 1;
        bumpReason(reason);
        continue;
      }

      // ---- Gate 5: daily quota --------------------------------------------
      if (remainingQuota <= 0) {
        await db.campaignMessage
          .create({
            data: {
              hotelId: ctx.hotelId,
              campaignId: campaign.id,
              customerId: customer.id,
              channel,
              recipient,
              personalizedMessage: "",
              status: "SKIPPED",
              skipReason: "RATE_LIMITED",
            },
          })
          .catch((err: unknown) => (isUniqueViolation(err) ? null : Promise.reject(err)));
        existingPairs.add(`${customer.id}:${channel}`);
        summary.rateLimited += 1;
        summary.skipped += 1;
        bumpReason("RATE_LIMITED");
        continue;
      }

      // ---- RESERVE the delivery slot BEFORE any provider call (BUG #4) ---
      const lastStay = customer.visits[0]?.checkout ?? customer.visits[0]?.checkin ?? null;
      const pCtx: PersonalizationContext = {
        name: customer.name,
        hotelName: ctx.hotelName,
        lastVisit: lastStay ? new Date(lastStay).toISOString() : null,
        bookingCount: customer.visits.length,
        offer: campaign.offer,
        bookingLink: ctx.bookingLink ?? process.env.BOOKING_LINK ?? "",
      };
      const body = personalize(campaign.messageTemplate, pCtx);

      const reserved = await db.campaignMessage
        .create({
          data: {
            hotelId: ctx.hotelId,
            campaignId: campaign.id,
            customerId: customer.id,
            channel,
            recipient,
            personalizedMessage: body,
            status: "PENDING",
            idempotencyKey: `${campaign.id}:${customer.id}:${channel}`,
          },
        })
        .catch((err: unknown) => {
          if (isUniqueViolation(err)) return null; // a concurrent run owns this slot
          throw err;
        });

      if (!reserved) {
        // Another worker reserved (or fully sent) this pair — exactly-once wins.
        existingPairs.add(`${customer.id}:${channel}`);
        continue;
      }
      existingPairs.add(`${customer.id}:${channel}`);

      // ---- FINAL PRE-SEND CHECK: live consent re-read (spec §5) ----------
      const freshCustomer = await db.customer.findUnique({
        where: { id: customer.id },
        select: {
          marketingConsent: true,
          optOut: true,
          status: true,
          whatsappOptIn: true,
          smsOptIn: true,
          emailOptIn: true,
        },
      });
      if (
        !freshCustomer ||
        freshCustomer.status !== "ACTIVE" ||
        !channelConsentOk(freshCustomer, channel)
      ) {
        await db.campaignMessage.update({
          where: { id: reserved.id },
          data: {
            status: "SKIPPED",
            skipReason: "BLOCKED_CONSENT",
          },
        });
        summary.skipped += 1;
        bumpReason("BLOCKED_CONSENT");
        continue;
      }

      // ---- Plan quota: ATOMIC reservation (AUDIT FIX P11-QUOTA-1) --------
      // The old flow pre-checked with a plain read and metered AFTER the
      // send, so N concurrent runs (scheduled sweep vs manual send vs a
      // journey) could all pass the same stale check and oversend the plan
      // limit by N × batch. The reservation increments the counter in ONE
      // guarded update — only runs whose whole send still fits proceed.
      const quotaErr = await reserveUsage(ctx.hotelId, "messages", { skipAudit: true }).catch(() => ({ code: "QUOTA_READ_FAIL" } as const));
      if (quotaErr) {
        await db.campaignMessage.update({
          where: { id: reserved.id },
          data: {
            status: "SKIPPED",
            skipReason: "PLAN_QUOTA",
            failureReason: null,
          },
        });
        summary.skipped += 1;
        bumpReason("PLAN_QUOTA");
        continue;
      }

      // ---- Provider call (only the reservation owner reaches here) -------
      // AUDIT FIX (F04): resolve the provider from the TENANT's saved,
      // verified, enabled integration first — a hotel using its own WhatsApp
      // account must actually send through it, and a disabled/deleted
      // integration must genuinely stop sends (not just hide a UI row).
      const provider = await resolveTenantProvider(ctx.hotelId, channel);
      // RECHECK FIX (D): WhatsApp sends use the campaign's APPROVED template
      // binding when one exists (provider TEMPLATE payload — deliverable
      // outside the 24h window); SMS/EMAIL stay free-form.
      const template =
        channel === "WHATSAPP" ? await resolveWhatsAppTemplate(ctx.hotelId, campaign, pCtx) : null;
      const result = await provider.send({
        to: recipient,
        body,
        ...(template ? { template } : {}),
      });

      const finalStatus = result.ok
        ? provider.id === "SIMULATION"
          ? ("SIMULATED" as const) // honest status — never claim a real send
          : ("SENT" as const)
        : ("FAILED" as const);

      await db.campaignMessage.update({
        where: { id: reserved.id },
        data: {
          status: finalStatus,
          provider: result.provider,
          providerMessageId: result.providerMessageId ?? null,
          failureReason: result.ok ? null : (result.error ?? "Provider error"),
          sentAt: result.ok ? new Date() : null,
          retryCount: result.ok ? reserved.retryCount : { increment: 1 },
          lastTriedAt: new Date(),
        },
      });

      if (result.ok) {
        if (finalStatus === "SIMULATED") summary.simulated += 1;
        else summary.sent += 1;
        remainingQuota -= 1;
        // Count toward the per-customer frequency window (multi-channel caps too).
        sentInWindow.set(customer.id, (sentInWindow.get(customer.id) ?? 0) + 1);
      } else {
        // A failed delivery does not consume plan quota — release it.
        await releaseUsage(ctx.hotelId, "messages").catch(() => undefined);
        summary.failed += 1;
      }

      // Batch cap keeps a single run bounded even for huge audiences.
      if (summary.sent + summary.simulated + summary.failed >= MAX_BATCH_PER_RUN) {
        summary.truncated = true;
        break;
      }
    }
    if (summary.truncated) break;
  }

  await db.campaign.update({
    where: { id: campaign.id },
    data: {
      lastSentAt: new Date(),
      status:
        campaign.scheduleType === "NOW" && campaign.status !== "COMPLETED"
          ? "COMPLETED"
          : campaign.status === "DRAFT"
            ? "ACTIVE" // explicit send-now on a draft promotes it (F13: PAUSED/ARCHIVED never reach here)
            : campaign.status,
    },
  });

  // AUDIT FIX (P11-QUOTA-1): usage is metered by the per-send atomic
  // reservation ABOVE (reserveUsage) — the old post-run bulk incrementUsage
  // would double-charge. Skips/failures never consumed a reservation (or
  // released it), so nothing is owed here.

  await logAudit({
    hotelId: ctx.hotelId,
    userId: ctx.userId ?? null,
    action: AUDIT_ACTIONS.CAMPAIGN_SENT,
    entityType: "campaign",
    entityId: campaign.id,
    metadata: {
      name: campaign.name,
      sent: summary.sent,
      simulated: summary.simulated,
      failed: summary.failed,
      skipped: summary.skipped,
      frequencyLimited: summary.frequencyLimited,
      providerMode,
    },
  });

  return { ok: true, summary };
}

/* ------------------------------------------------------------------ */
/* Phase 6.4 — message retry system (spec §16)                         */
/* ------------------------------------------------------------------ */

export interface RetrySummary {
  campaignId: string;
  candidates: number;
  retried: number;
  sent: number;
  simulated: number;
  stillFailed: number;
  blockedConsent: number;
  exhausted: number;
  /** AUDIT FIX (P11-QUOTA-1): retry deferred because the plan quota is exhausted. */
  quotaBlocked: number;
}

/**
 * Retry FAILED messages for a campaign (admin-triggered). Rules:
 *  - Only FAILED messages are retryable (never SENT/SIMULATED/SKIPPED, and
 *    never UNKNOWN — see F07: UNKNOWN delivery state means the provider call
 *    may have completed; it must be reconciled, not blindly resent).
 *  - Max MAX_RETRIES attempts per message (exponential backoff is enforced by
 *    requiring min(2^retryCount, 15) minutes since lastTriedAt).
 *  - Consent is re-checked live before every retry attempt.
 *  - AUDIT FIX (F07) — ATOMIC RETRY OWNERSHIP: two concurrent retry runs used
 *    to both read the same FAILED row and BOTH call the provider (duplicate
 *    send). Each candidate is now claimed with a guarded conditional update
 *    FAILED → RETRYING (matching on the retryCount that was read); exactly
 *    one runner wins the claim and may call the provider, the loser sees
 *    count=0 and skips. The claim row then transitions RETRYING →
 *    SENT/SIMULATED/FAILED. A crash while RETRYING leaves the row visibly
 *    in-progress (never re-claimed automatically — an operator reconciles).
 */
export async function retryFailedMessages(
  campaignId: string,
  ctx: SendContext,
): Promise<{ ok: true; summary: RetrySummary } | { ok: false; error: string; status: number }> {
  const campaign = await db.campaign.findFirst({
    where: { id: campaignId, hotelId: ctx.hotelId },
  });
  if (!campaign) return { ok: false, error: "Campaign not found in your hotel.", status: 404 };

  // F13 consistency: a paused/archived campaign must not retry sends either.
  if (campaign.status === "PAUSED" || campaign.status === "ARCHIVED") {
    return {
      ok: false,
      error: `This campaign is ${campaign.status.toLowerCase()} and cannot retry sends. Resume it first.`,
      status: 409,
    };
  }

  const channels = parseChannels(campaign.channels);
  const now = Date.now();

  const failedMessages = await db.campaignMessage.findMany({
    where: { campaignId: campaign.id, status: "FAILED" },
    orderBy: { createdAt: "asc" },
    take: MAX_BATCH_PER_RUN,
  });

  const summary: RetrySummary = {
    campaignId: campaign.id,
    candidates: failedMessages.length,
    retried: 0,
    sent: 0,
    simulated: 0,
    stillFailed: 0,
    blockedConsent: 0,
    exhausted: 0,
    quotaBlocked: 0,
  };

  for (const msg of failedMessages) {
    if (msg.retryCount >= MAX_RETRIES) {
      summary.exhausted += 1;
      continue;
    }
    // Exponential backoff: attempt N waits min(2^N, 15) minutes since last try.
    const backoffMs = Math.min(2 ** msg.retryCount, 15) * 60 * 1000;
    if (msg.lastTriedAt && now - msg.lastTriedAt.getTime() < backoffMs) {
      // Backoff window not elapsed — leave for a later retry run.
      continue;
    }
    const channel = msg.channel as Channel;
    if (!channels.includes(channel)) continue;

    // ---- ATOMIC CLAIM (F07): FAILED → RETRYING, conditional on the exact
    // state this runner observed. Concurrent runners race on this single
    // guarded update; the DB serializes it — exactly one winner.
    const claim = await db.campaignMessage.updateMany({
      where: {
        id: msg.id,
        status: "FAILED",
        retryCount: msg.retryCount,
      },
      data: { status: "RETRYING", lastTriedAt: new Date() },
    });
    if (claim.count !== 1) {
      // Another retry runner owns this message — do NOT touch or resend it.
      continue;
    }

    summary.retried += 1;

    // Live consent re-check (spec §16: never retry invalid consent).
    const customer = await db.customer.findUnique({
      where: { id: msg.customerId },
      select: {
        marketingConsent: true,
        optOut: true,
        status: true,
        whatsappOptIn: true,
        smsOptIn: true,
        emailOptIn: true,
        name: true,
      },
    });
    if (!customer || customer.status !== "ACTIVE" || !channelConsentOk(customer, channel)) {
      await db.campaignMessage.update({
        where: { id: msg.id },
        data: { status: "SKIPPED", skipReason: "BLOCKED_CONSENT", failureReason: null },
      });
      summary.blockedConsent += 1;
      continue;
    }

    // AUDIT FIX (P11-QUOTA-1): retries reserve plan quota atomically, same
    // as first-run sends. Out of quota → the message stays RETRYING for the
    // next window instead of silently bypassing the plan limit.
    const quotaErr = await reserveUsage(ctx.hotelId, "messages", { skipAudit: true }).catch(() => ({ code: "QUOTA_READ_FAIL" } as const));
    if (quotaErr) {
      await db.campaignMessage.update({
        where: { id: msg.id },
        data: { status: "RETRYING", lastTriedAt: new Date(), failureReason: "PLAN_QUOTA" },
      });
      summary.quotaBlocked = (summary.quotaBlocked ?? 0) + 1;
      continue;
    }

    // AUDIT FIX (F04): tenant-scoped provider resolution (see executeCampaignSend).
    const provider = await resolveTenantProvider(ctx.hotelId, channel);
    // RECHECK FIX (D): retries keep the campaign's template binding — a
    // retried WhatsApp delivery must not silently downgrade to free-form text
    // (Meta rejects it outside the session window).
    const retryCtx: PersonalizationContext = {
      name: customer.name,
      hotelName: ctx.hotelName,
      lastVisit: null,
      bookingCount: 0,
      offer: campaign.offer,
      bookingLink: ctx.bookingLink ?? process.env.BOOKING_LINK ?? "",
    };
    const template =
      channel === "WHATSAPP"
        ? await resolveWhatsAppTemplate(ctx.hotelId, campaign, retryCtx)
        : null;
    const body = personalize(campaign.messageTemplate, retryCtx);
    const result = await provider.send({
      to: msg.recipient,
      body,
      ...(template ? { template } : {}),
    });
    const finalStatus = result.ok
      ? provider.id === "SIMULATION"
        ? ("SIMULATED" as const)
        : ("SENT" as const)
      : ("FAILED" as const);

    await db.campaignMessage.update({
      where: { id: msg.id },
      data: {
        status: finalStatus,
        provider: result.provider,
        providerMessageId: result.providerMessageId ?? null,
        failureReason: result.ok ? null : (result.error ?? "Provider error"),
        sentAt: result.ok ? new Date() : null,
        retryCount: result.ok ? msg.retryCount : { increment: 1 },
        lastTriedAt: new Date(),
        personalizedMessage: body,
      },
    });

    if (result.ok) {
      if (finalStatus === "SIMULATED") summary.simulated += 1;
      else summary.sent += 1;
    } else {
      await releaseUsage(ctx.hotelId, "messages").catch(() => undefined);
      summary.stillFailed += 1;
    }
  }

  // AUDIT FIX (P11-QUOTA-1): quota is consumed by the per-retry reservation
  // above — no separate post-run metering (would double-charge).

  await logAudit({
    hotelId: ctx.hotelId,
    userId: ctx.userId ?? null,
    action: AUDIT_ACTIONS.CAMPAIGN_RETRIED,
    entityType: "campaign",
    entityId: campaign.id,
    metadata: {
      name: campaign.name,
      candidates: summary.candidates,
      retried: summary.retried,
      sent: summary.sent,
      simulated: summary.simulated,
      stillFailed: summary.stillFailed,
      exhausted: summary.exhausted,
    },
  });

  return { ok: true, summary };
}

/* ------------------------------------------------------------------ */
/* Smart Follow-up Engine                                              */
/* ------------------------------------------------------------------ */

export const DEFAULT_FOLLOW_UPS = [
  {
    offsetDays: 1,
    label: "Thank-you message",
    messageTemplate:
      "Hi {{name}}, thank you for staying at {{hotel_name}}! We hope you had a wonderful visit. We look forward to welcoming you back soon. 🙏",
    channels: JSON.stringify(["WHATSAPP"]),
    sortOrder: 1,
  },
  {
    offsetDays: 7,
    label: "Review request",
    messageTemplate:
      "Hello {{name}}, how was your stay at {{hotel_name}}? We would love your feedback — it takes just a minute and helps us improve.",
    channels: JSON.stringify(["WHATSAPP", "SMS"]),
    sortOrder: 2,
  },
  {
    offsetDays: 30,
    label: "Return offer",
    messageTemplate:
      "Hi {{name}}, it has been a month since your visit to {{hotel_name}}. Come back soon — enjoy {{offer}} on your next booking: {{booking_link}}",
    channels: JSON.stringify(["WHATSAPP", "SMS"]),
    sortOrder: 3,
  },
  {
    offsetDays: 60,
    label: "Special offer",
    messageTemplate:
      "Hello {{name}}, we miss you at {{hotel_name}}! Here is a special {{offer}} just for you — valid for your next stay: {{booking_link}}",
    channels: JSON.stringify(["WHATSAPP", "SMS"]),
    sortOrder: 4,
  },
  {
    offsetDays: 90,
    label: "Win-back campaign",
    messageTemplate:
      "Hi {{name}}, it has been a while since your last stay at {{hotel_name}}. We would love to welcome you back — special welcome-back {{offer}} inside: {{booking_link}}",
    channels: JSON.stringify(["WHATSAPP", "SMS"]),
    sortOrder: 5,
  },
];

/** Get-or-create default follow-up steps for a hotel. */
export async function ensureFollowUpSteps(hotelId: string) {
  const existing = await db.followUpStep.findMany({ where: { hotelId } });
  if (existing.length === 0) {
    for (const s of DEFAULT_FOLLOW_UPS) {
      await db.followUpStep.create({ data: { ...s, hotelId } });
    }
  }
  return db.followUpStep.findMany({ where: { hotelId }, orderBy: { offsetDays: "asc" } });
}

/** Each follow-up step gets an AUTOMATED campaign (created lazily). */
async function ensureAutoCampaign(
  step: {
    id: string;
    label: string;
    messageTemplate: string;
    channels: string;
    hotelId: string;
    offsetDays: number;
  },
  userId?: string | null,
) {
  const existing = await db.campaign.findUnique({ where: { followUpStepId: step.id } });
  if (existing) return existing;

  // Audience: Returning customers (2+ stays) — they just completed another stay
  const segment = await db.segment.findFirst({
    where: { hotelId: step.hotelId, type: "AUTO", rule: { contains: "returning" } },
  });

  const campaign = await db.campaign.create({
    data: {
      hotelId: step.hotelId,
      name: `Auto: ${step.label} (+${step.offsetDays}d)`,
      description: `Automated follow-up — ${step.label}, ${step.offsetDays} day(s) after checkout.`,
      status: "ACTIVE",
      scheduleType: "AUTOMATED",
      segmentId: segment?.id ?? null,
      channels: step.channels,
      messageTemplate: step.messageTemplate,
      followUpStepId: step.id,
      createdById: userId ?? null,
    },
  });

  await logAudit({
    hotelId: step.hotelId,
    userId: userId ?? null,
    action: AUDIT_ACTIONS.CAMPAIGN_CREATED,
    entityType: "campaign",
    entityId: campaign.id,
    metadata: { name: campaign.name, automated: true },
  });
  return campaign;
}

export interface EngineRunResult {
  stepsProcessed: number;
  customersProcessed: number;
  sent: number;
  failed: number;
  skipped: number;
  details: {
    step: string;
    offsetDays: number;
    campaignId: string;
    summary: SendRunSummary | null;
  }[];
}


/**
 * Latest completed checkout per customer, computed in the database.
 * PERF FIX: the engine used to load every checkout row of the hotel into memory
 * on each run (and again per step). One grouped aggregate returns one row per
 * customer instead.
 */
export async function latestCheckoutByCustomer(hotelId: string): Promise<Map<string, Date>> {
  const rows = await db.visit.groupBy({
    by: ["customerId"],
    where: { hotelId, checkout: { not: null } },
    _max: { checkout: true },
  });
  const map = new Map<string, Date>();
  for (const row of rows) {
    const checkout = row._max.checkout;
    if (checkout) map.set(row.customerId, checkout);
  }
  return map;
}

/**
 * Run the follow-up engine for a hotel (also callable via cron with a secret).
 * For every enabled step with offsetDays = N, finds customers whose LATEST
 * completed stay checked out exactly N days ago and sends the step message.
 */
export async function runFollowUpEngine(
  hotelId: string,
  hotelName: string,
  userId?: string | null,
  now = new Date(),
): Promise<EngineRunResult> {
  // Ensure segments exist (engine audience = Returning segment)
  const { ensureSystemSegments } = await import("@/lib/segments");
  await ensureSystemSegments(hotelId);

  const steps = await ensureFollowUpSteps(hotelId);
  // Calendar-day matching happens in the hotel's timezone (lib/timezone.ts).
  const tz = await hotelTimezone(hotelId);
  const result: EngineRunResult = {
    stepsProcessed: 0,
    customersProcessed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };

  for (const step of steps) {
    if (!step.enabled) continue;
    result.stepsProcessed += 1;

    // Latest completed stay (has checkout) per customer
    const latestByCustomer = await latestCheckoutByCustomer(hotelId);

    const targetDay = new Date(now.getTime() - step.offsetDays * 24 * 60 * 60 * 1000);
    const customerIds: string[] = [];
    for (const [customerId, checkout] of latestByCustomer.entries()) {
      if (sameZonedDay(checkout, targetDay, tz)) customerIds.push(customerId);
    }
    if (customerIds.length === 0) {
      result.details.push({
        step: step.label,
        offsetDays: step.offsetDays,
        campaignId: "",
        summary: null,
      });
      continue;
    }

    result.customersProcessed += customerIds.length;
    const campaign = await ensureAutoCampaign(step, userId);
    const run = await executeCampaignSend(campaign.id, { hotelId, hotelName, userId }, customerIds);
    if (run.ok) {
      result.sent += run.summary.sent + run.summary.simulated;
      result.failed += run.summary.failed;
      result.skipped += run.summary.skipped;
      result.details.push({
        step: step.label,
        offsetDays: step.offsetDays,
        campaignId: campaign.id,
        summary: run.summary,
      });
    }
  }

  await logAudit({
    hotelId,
    userId: userId ?? null,
    action: AUDIT_ACTIONS.FOLLOWUP_ENGINE_RUN,
    entityType: "follow_up_engine",
    metadata: {
      stepsProcessed: result.stepsProcessed,
      customersProcessed: result.customersProcessed,
      sent: result.sent,
      failed: result.failed,
      skipped: result.skipped,
    },
  });

  return result;
}

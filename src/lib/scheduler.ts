/**
 * Phase 11 — durable scheduler sweeps.
 *
 * The standalone worker previously only CONSUMED the job queue (campaign
 * sends handed to it by HTTP routes, CSV exports, payment follow-ups) plus
 * SaaS maintenance. NOTHING ever:
 *   - dispatched SCHEDULED campaigns when their time came (owners had to press
 *     "Send now" manually — a scheduled campaign just sat in SCHEDULED),
 *   - ran automation trigger scans (the /api/automations/run route existed but
 *     had to be invoked by hand or by an external cron that was never wired),
 *   - executed Journeys (the Journey/JourneyStep models existed but there was
 *     no enrollment model and no execution engine at all).
 *
 * This module closes those gaps with three idempotent sweeps, all designed
 * for MULTIPLE concurrent workers:
 *
 *   sweepDueCampaigns()  — atomically claim due SCHEDULED campaigns
 *                          (status re-check inside one updateMany → only one
 *                          worker wins) and enqueue exactly one CAMPAIGN_SEND
 *                          job per campaign. Missed runs catch up naturally:
 *                          anything with scheduledAt <= now is due.
 *
 *   sweepAutomationTriggers() — periodic trigger scan for ACTIVE hotels
 *                          (reuses scanAutomationTriggers — same engine as
 *                          the manual route) + drain PENDING executions that
 *                          are due. Occurrence dedup lives in ensureExecution
 *                          (one execution per automation/customer/trigger-day).
 *
 *   sweepJourneys()      — advance ACTIVE enrollments whose nextStepAt is due:
 *                          one delivery reservation per step/customer/
 *                          occurrence (unique constraint), sent through the
 *                          SAME occurrence-scoped campaign + consent-gated
 *                          send pipeline automations use. Paused/cancelled
 *                          enrollments are skipped; progress is persisted
 *                          per customer (nextStepIndex), so a worker crash
 *                          resumes exactly where it stopped.
 *
 * All three are safe to run concurrently and after restarts — DB-level
 * uniqueness + status re-checks are the synchronization primitives, exactly
 * like the job queue's lease fencing.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { scanAutomationTriggers, runExecution } from "@/lib/automations";
import { executeCampaignSend } from "@/lib/campaigns";

/** Per-delivery retry budget before the step is dead-lettered as FAILED. */
const MAX_DELIVERY_RETRIES = 3;
// AUDIT FIX (P11-JRN-1): a SENDING claim older than this is considered lost
// (worker crashed mid-send) and is reclaimed by the next sweep.
const STALE_SENDING_MS = 15 * 60_000;

/** How far ahead a sweep looks (everything due at or before `now`). */
export interface SweepResult {
  campaignsDispatched: number;
  hotelsScanned: number;
  executionsQueued: number;
  executionsRun: number;
  journeyDeliveriesSent: number;
  journeyDeliveriesSkipped: number;
  journeyDeliveriesFailed: number;
  journeyEnrollmentsCompleted: number;
}

export function emptySweepResult(): SweepResult {
  return {
    campaignsDispatched: 0,
    hotelsScanned: 0,
    executionsQueued: 0,
    executionsRun: 0,
    journeyDeliveriesSent: 0,
    journeyDeliveriesSkipped: 0,
    journeyDeliveriesFailed: 0,
    journeyEnrollmentsCompleted: 0,
  };
}

/* ------------------------------------------------------------------ */
/* 1. Due scheduled campaigns                                          */
/* ------------------------------------------------------------------ */

/**
 * Claim + dispatch campaigns whose scheduledAt has arrived. The claim AND the
 * CAMPAIGN_SEND job creation run inside ONE transaction (BUG-2/D11): a crash
 * or DB error between claim and enqueue can no longer strand a campaign as
 * ACTIVE with no job — either both the SCHEDULED→ACTIVE flip and the job row
 * commit, or neither does. (The old at-most-once window silently LOST
 * scheduled sends; this is now exactly-once.) Only the worker that flips
 * SCHEDULED→ACTIVE enqueues, so N concurrent workers still dispatch exactly
 * once. executeCampaignSend itself is reserve-then-send idempotent on top.
 */
export async function sweepDueCampaigns(now = new Date()): Promise<number> {
  const due = await db.campaign.findMany({
    where: {
      status: "SCHEDULED",
      scheduleType: "SCHEDULED",
      scheduledAt: { lte: now },
      hotel: { status: "ACTIVE" },
    },
    select: { id: true, hotelId: true, hotel: { select: { name: true } } },
    take: 50, // per-tick cap — a big backlog drains over successive ticks
  });

  let dispatched = 0;
  for (const campaign of due) {
    try {
      await db.$transaction(async (tx) => {
        // Atomic claim: only a worker that flips SCHEDULED→ACTIVE enqueues.
        const claim = await tx.campaign.updateMany({
          where: { id: campaign.id, status: "SCHEDULED" },
          data: { status: "ACTIVE" },
        });
        if (claim.count !== 1) return; // another worker won the race

        // Job creation in the SAME transaction — BUG-2's lost-send window.
        // (Same row shape enqueueJob writes; logging happens after commit.)
        await tx.backgroundJob.create({
          data: {
            type: "CAMPAIGN_SEND",
            payload: JSON.stringify({
              campaignId: campaign.id,
              hotelId: campaign.hotelId,
              // BUG-6: the worker-rendered template needs the tenant name —
              // otherwise every scheduled send said "staying at !".
              hotelName: campaign.hotel.name,
              reason: "scheduled",
            }),
            hotelId: campaign.hotelId,
            runAt: now,
            maxAttempts: 3,
          },
          select: { id: true },
        });
      });
      dispatched += 1;
      logger.info("scheduler.campaign_dispatched", {
        campaignId: campaign.id,
        lateMs: 0,
      });
    } catch (err) {
      // The claim rolled back with the job create — the campaign stays
      // SCHEDULED and the NEXT sweep retries it. Never lost, never doubled.
      logger.error("scheduler.campaign_dispatch_failed", {
        campaignId: campaign.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return dispatched;
}

/* ------------------------------------------------------------------ */
/* 2. Automation trigger scans + pending execution drain                */
/* ------------------------------------------------------------------ */

/**
 * Run the trigger scan for every ACTIVE hotel and drain due PENDING
 * executions. The scan itself is idempotent per (automation, customer,
 * trigger-day) — running it from N workers or twice after a restart creates
 * the same single execution row (ensureExecution dedupes).
 */
export async function sweepAutomationTriggers(
  now = new Date(),
  opts?: { runPending?: boolean },
): Promise<{ hotelsScanned: number; executionsQueued: number; executionsRun: number }> {
  const hotels = await db.hotel.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true },
    take: 500,
  });

  let executionsQueued = 0;
  for (const hotel of hotels) {
    try {
      const result = await scanAutomationTriggers(hotel.id, hotel.name, now);
      executionsQueued += result.queued;
    } catch (err) {
      logger.error("scheduler.automation_scan_failed", {
        hotelId: hotel.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let executionsRun = 0;
  if (opts?.runPending !== false) {
    // BUG-4/D-reaper: executions stuck in PROCESSING (worker crashed
    // mid-run) are reclaimed back to PENDING so they retry — nothing
    // recovers them otherwise, and the row would be stuck forever.
    const staleCutoff = new Date(now.getTime() - 15 * 60 * 1000);
    const reaped = await db.automationExecution.updateMany({
      where: { status: "PROCESSING", executedAt: { lt: staleCutoff } },
      data: { status: "PENDING" },
    });
    if (reaped.count > 0) {
      logger.warn("scheduler.automation_stale_reaped", { count: reaped.count });
    }

    // Drain due executions (scheduledAt <= now), bounded per tick.
    const pending = await db.automationExecution.findMany({
      where: { status: "PENDING", scheduledAt: { lte: now } },
      select: { id: true },
      orderBy: { scheduledAt: "asc" },
      take: 100,
    });
    for (const exec of pending) {
      try {
        const result = await runExecution(exec.id, now);
        executionsRun += 1;
        if (!result.ok && result.reason) {
          logger.warn("scheduler.automation_execution_failed", {
            executionId: exec.id,
            reason: result.reason.slice(0, 200),
          });
        }
      } catch (err) {
        logger.error("scheduler.automation_execution_error", {
          executionId: exec.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { hotelsScanned: hotels.length, executionsQueued, executionsRun };
}

/* ------------------------------------------------------------------ */
/* 3. Journey execution                                                */
/* ------------------------------------------------------------------ */

/**
 * Enroll a customer into a journey (idempotent — the unique
 * (journeyId, customerId) constraint means a repeat call is a no-op).
 * The first step's due time is computed from the step's offsetDays.
 */
export async function enrollJourneyCustomer(
  journeyId: string,
  customerId: string,
  hotelId: string,
  now = new Date(),
): Promise<{ ok: boolean; already?: boolean; reason?: string }> {
  const journey = await db.journey.findFirst({
    where: { id: journeyId, hotelId, enabled: true },
    include: { steps: { where: { enabled: true }, orderBy: { sortOrder: "asc" } } },
  });
  if (!journey) return { ok: false, reason: "Journey not found or disabled." };
  if (journey.steps.length === 0) return { ok: false, reason: "Journey has no enabled steps." };

  // The customer must belong to the same tenant (cross-tenant enrollment is
  // never allowed — caller-supplied ids are not trusted).
  const customer = await db.customer.findFirst({ where: { id: customerId, hotelId } });
  if (!customer) return { ok: false, reason: "Customer not found." };

  const first = journey.steps[0];
  const nextStepAt = new Date(now.getTime() + first.offsetDays * 24 * 60 * 60 * 1000);

  try {
    await db.journeyEnrollment.create({
      data: {
        hotelId,
        journeyId,
        customerId,
        nextStepIndex: 0,
        nextStepAt,
      },
    });
    return { ok: true };
  } catch {
    // Unique violation → already enrolled (no enum introspection needed —
    // the ONLY unique constraint on this model is (journeyId, customerId)).
    return { ok: true, already: true };
  }
}

/** Human/stable occurrence key: the UTC DAY the step is due. */
function occurrenceKeyFor(due: Date): string {
  return due.toISOString().slice(0, 10);
}

/**
 * Advance every due ACTIVE journey enrollment by one step.
 *
 * Exactly-once guarantee: the JourneyStepDelivery unique constraint on
 * (enrollmentId, journeyStepId, occurrenceKey) means a retried sweep after a
 * crash can never re-send a step that was already delivered on that
 * occurrence.
 *
 * BUG-5/D12 fix — the cursor only advances on a TERMINAL delivery outcome:
 *  - a PENDING reservation left behind by a crashed worker is RETRIED by the
 *    next sweep (the campaign reservation keeps the actual send idempotent),
 *    not skipped;
 *  - a transient send failure records FAILED (retryCount++) and is retried
 *    with the sweep's natural cadence until MAX_DELIVERY_RETRIES, then the
 *    cursor advances and the FAILED row stays visible for operators —
 *    messages are never silently dropped, and journeys never stall forever;
 *  - only SENT / SKIPPED (or budget-exhausted FAILED) advance the cursor.
 *
 * BUG-5/D13 fix: enrollments of a DISABLED journey are not processed —
 * disabling a journey now actually stops its active enrollments.
 *
 * Sends go through the SAME occurrence-scoped campaign + consent-gated
 * pipeline automations use (executeCampaignSend with a one-customer audience
 * override) — no parallel messaging engine, consent/opt-out/quota checks all
 * apply, and a consent-blocked send is recorded SKIPPED, not SENT.
 */
export async function sweepJourneys(now = new Date()): Promise<{
  sent: number;
  skipped: number;
  failed: number;
  completed: number;
}> {
  const due = await db.journeyEnrollment.findMany({
    where: {
      status: "ACTIVE",
      nextStepAt: { lte: now },
      // D13: a disabled journey stops delivering — the operator's only
      // lever must actually work.
      journey: { enabled: true },
    },
    include: {
      journey: {
        include: { steps: { where: { enabled: true }, orderBy: { sortOrder: "asc" } } },
      },
      customer: {
        select: {
          id: true,
          name: true,
          hotelId: true,
          marketingConsent: true,
          optOut: true,
        },
      },
    },
    orderBy: { nextStepAt: "asc" },
    take: 100, // execution cap per tick
  });

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let completed = 0;

  // AUDIT FIX (P11-JRN-1) — stale-claim reaper: a worker that died mid-send
  // leaves SENDING rows behind. Reclaim them after the lease window so the
  // step is retried (the occurrence-scoped campaign reservation keeps the
  // actual message idempotent — a reused campaign can never double-send).
  const reaped = await db.journeyStepDelivery.updateMany({
    where: { status: "SENDING", updatedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) } },
    data: { status: "PENDING" },
  });
  if (reaped.count > 0) {
    logger.warn("scheduler.journey_stale_sending_reclaimed", { count: reaped.count });
  }

  for (const enrollment of due) {
    const steps = enrollment.journey.steps;
    const step = steps[enrollment.nextStepIndex];

    if (!step) {
      // Cursor past the last step → mark completed (crash-safe catch-up).
      await db.journeyEnrollment.update({
        where: { id: enrollment.id },
        data: { status: "COMPLETED", completedAt: now, nextStepAt: null },
      });
      completed += 1;
      continue;
    }

    // Delivery reservation — the unique constraint is the exactly-once fence.
    const occurrenceKey = occurrenceKeyFor(enrollment.nextStepAt ?? now);
    let delivery = await db.journeyStepDelivery.findUnique({
      where: {
        enrollmentId_journeyStepId_occurrenceKey: {
          enrollmentId: enrollment.id,
          journeyStepId: step.id,
          occurrenceKey,
        },
      },
    });
    if (!delivery) {
      try {
        delivery = await db.journeyStepDelivery.create({
          data: {
            enrollmentId: enrollment.id,
            journeyStepId: step.id,
            hotelId: enrollment.hotelId,
            customerId: enrollment.customerId,
            occurrenceKey,
            status: "PENDING",
            scheduledFor: enrollment.nextStepAt ?? now,
          },
        });
      } catch {
        // Reservation already exists for this occurrence → a previous run
        // created it. Re-read and CONTINUE below — if it is PENDING/FAILED it
        // is retried here (D12: a crashed worker's reservation is no longer
        // treated as delivered); only a terminal row advances the cursor.
        delivery = await db.journeyStepDelivery.findUnique({
          where: {
            enrollmentId_journeyStepId_occurrenceKey: {
              enrollmentId: enrollment.id,
              journeyStepId: step.id,
              occurrenceKey,
            },
          },
        });
        if (!delivery) continue; // vanished again — next sweep retries
      }
    }

    // Terminal outcomes → advance the cursor.
    if (delivery.status === "SENT" || delivery.status === "SKIPPED") {
      if (delivery.status === "SENT") sent += 1;
      else skipped += 1;
      await advanceCursor(enrollment.id, steps, enrollment.nextStepIndex, enrollment.enrolledAt, now);
      continue;
    }

    // FAILED with the retry budget exhausted → dead-letter the step (the row
    // stays FAILED + visible), advance so the journey keeps moving.
    if (delivery.status === "FAILED" && delivery.retryCount >= MAX_DELIVERY_RETRIES) {
      logger.error("scheduler.journey_delivery_deadletter", {
        deliveryId: delivery.id,
        enrollmentId: enrollment.id,
        error: delivery.error ?? "unknown",
      });
      failed += 1;
      await advanceCursor(enrollment.id, steps, enrollment.nextStepIndex, enrollment.enrolledAt, now);
      continue;
    }

    // Consent pre-check (executeCampaignSend re-checks too — this just avoids
    // creating a campaign row for a customer who will be skipped anyway).
    const customer = enrollment.customer;
    if (customer.optOut || !customer.marketingConsent) {
      await db.journeyStepDelivery.updateMany({
        where: {
          id: delivery.id,
          status: "PENDING",
        },
        data: { status: "SKIPPED", error: "CONSENT" },
      });
      await advanceCursor(enrollment.id, steps, enrollment.nextStepIndex, enrollment.enrolledAt, now);
      skipped += 1;
      continue;
    }

    // Occurrence-scoped campaign (same pattern as automations): retries of the
    // SAME occurrence reuse the same campaign → the send pipeline's
    // (campaignId, customerId, channel) unique reservation blocks duplicates.
    const hotel = await db.hotel.findUnique({
      where: { id: enrollment.hotelId },
      select: { name: true, status: true },
    });
    if (!hotel || hotel.status !== "ACTIVE") {
      // Disabled/suspended tenant: release the PENDING reservation; the sweep
      // retries when the tenant is reactivated. Do not burn the occurrence.
      await db.journeyStepDelivery.deleteMany({
        where: { id: delivery.id, status: "PENDING" },
      });
      continue;
    }

    const campaignName = `Journey: ${enrollment.journey.name} · Step ${step.sortOrder + 1} · ${occurrenceKey}`;
    // AUDIT FIX (P11-JRN-1) — pre-send CAS claim (PENDING → SENDING). Two
    // concurrent sweeps previously BOTH ran executeCampaignSend for the same
    // delivery; when both also created separate occurrence campaigns
    // (find-then-create race), the (campaignId, customerId, channel)
    // reservation could not dedupe across them and the customer received the
    // step twice. The claim serializes senders; the final outcome is fenced
    // on SENDING, and a crash is recovered by the stale-claim reaper.
    const claim = await db.journeyStepDelivery.updateMany({
      where: { id: delivery.id, status: "PENDING" },
      data: { status: "SENDING" },
    });
    if (claim.count !== 1) continue; // another worker owns this delivery

    let campaign = await db.campaign.findFirst({
      where: { hotelId: enrollment.hotelId, name: campaignName },
      select: { id: true },
    });
    if (!campaign) {
      campaign = await db.campaign.create({
        data: {
          hotelId: enrollment.hotelId,
          name: campaignName,
          description: `Generated by journey: ${enrollment.journey.name} (step ${step.sortOrder + 1}, occurrence ${occurrenceKey})`,
          status: "ACTIVE",
          scheduleType: "AUTOMATED",
          channels: step.channels,
          messageTemplate: step.messageTemplate,
          offer: step.offer ?? null,
          couponId: step.couponId ?? null,
        },
        select: { id: true },
      });
    }

    try {
      const result = await executeCampaignSend(
        campaign.id,
        { hotelId: enrollment.hotelId, hotelName: hotel.name },
        [enrollment.customerId],
      );
      const delivered = result.ok && result.summary.sent + result.summary.simulated > 0;
      const outcome = delivered
        ? ({ status: "SENT" as const, sentAt: now })
        : result.ok
          ? ({ status: "SKIPPED" as const, error: "NO_DELIVERY" })
          : ({
              status: "FAILED" as const,
              error: (result.error ?? "").slice(0, 200),
              retryCount: { increment: 1 },
            });
      const updated = await db.journeyStepDelivery.updateMany({
        where: { id: delivery.id, status: "SENDING" }, // fenced on the pre-send claim
        data: outcome,
      });
      if (updated.count !== 1) continue; // another worker finished it — next sweep advances
      if (delivered) sent += 1;
      else if (result.ok) skipped += 1;
      else failed += 1;
    } catch (err) {
      await db.journeyStepDelivery.updateMany({
        where: { id: delivery.id, status: "SENDING" },
        data: {
          status: "FAILED",
          error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
          retryCount: { increment: 1 },
        },
      });
      failed += 1;
      // No cursor advance — D12: a FAILED step retries next sweep (budget above).
      continue;
    }

    await advanceCursor(enrollment.id, steps, enrollment.nextStepIndex, enrollment.enrolledAt, now);
  }

  return { sent, skipped, failed, completed };
}

/** Move the enrollment cursor to the next step (or COMPLETE it). */
async function advanceCursor(
  enrollmentId: string,
  steps: { offsetDays: number }[],
  currentIndex: number,
  enrolledAt: Date,
  now: Date,
): Promise<void> {
  const nextIndex = currentIndex + 1;
  if (nextIndex >= steps.length) {
    await db.journeyEnrollment.update({
      where: { id: enrollmentId },
      data: { status: "COMPLETED", completedAt: now, nextStepIndex: nextIndex, nextStepAt: null },
    });
    return;
  }
  // Step due times are anchored to ENROLLMENT time (day 0), not to when the
  // previous step happened to be processed — missed runs catch up (due <= now
  // on the next sweep) without drifting the whole schedule.
  const nextStepAt = new Date(
    enrolledAt.getTime() + steps[nextIndex].offsetDays * 24 * 60 * 60 * 1000,
  );
  await db.journeyEnrollment.update({
    where: { id: enrollmentId },
    data: { nextStepIndex: nextIndex, nextStepAt },
  });
}

/* ------------------------------------------------------------------ */
/* Combined sweep (worker heartbeat)                                   */
/* ------------------------------------------------------------------ */

/** Run all three sweeps once. Safe to call concurrently / after restart. */
export async function runSchedulerSweep(now = new Date()): Promise<SweepResult> {
  const result = emptySweepResult();
  try {
    result.campaignsDispatched = await sweepDueCampaigns(now);
  } catch (err) {
    logger.error("scheduler.campaign_sweep_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const auto = await sweepAutomationTriggers(now);
    result.hotelsScanned = auto.hotelsScanned;
    result.executionsQueued = auto.executionsQueued;
    result.executionsRun = auto.executionsRun;
  } catch (err) {
    logger.error("scheduler.automation_sweep_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const journey = await sweepJourneys(now);
    result.journeyDeliveriesSent = journey.sent;
    result.journeyDeliveriesSkipped = journey.skipped;
    result.journeyDeliveriesFailed = journey.failed;
    result.journeyEnrollmentsCompleted = journey.completed;
  } catch (err) {
    logger.error("scheduler.journey_sweep_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return result;
}

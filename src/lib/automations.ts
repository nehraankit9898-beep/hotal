import { db } from "@/lib/db";
import { hotelTimezone, sameZonedDay } from "@/lib/timezone";
import { logAudit } from "@/lib/audit";
import { executeCampaignSend } from "@/lib/campaigns";

/**
 * Automation Engine — Phase 4
 *
 * Visual workflow: TRIGGER → WAIT → CONDITION → ACTION → TRACK
 *
 * Triggers supported (real):
 *   HOTEL_CHECKOUT, RESTAURANT_VISIT, INACTIVE_7/15/30,
 *   BIRTHDAY, ANNIVERSARY, VIP_THRESHOLD, OFFER_UNUSED, REPEAT_VISIT,
 *   CAMPAIGN_OPENED, CAMPAIGN_CLICKED, CAMPAIGN_REPLIED
 *
 * Conditions (JSON list, AND-ed):
 *   { kind: "marketing_consent", value: true }
 *   { kind: "min_visits", value: 2 }
 *   { kind: "segment", value: "<segmentId>" }
 *   { kind: "min_spend", value: 10000 }
 *
 * Actions (JSON list, executed in order):
 *   { kind: "send_message", channels: ["WHATSAPP"], template: "..." }
 *   { kind: "issue_coupon", couponId: "..." }
 *   { kind: "add_segment", segmentId: "..." }
 *   { kind: "add_note", text: "..." }
 *   { kind: "tag_vip" }
 *
 * Execution is idempotent: each (automation, customer, trigger date) is
 * recorded once in AutomationExecution — retries don't double-send.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AutomationCondition {
  kind: "marketing_consent" | "min_visits" | "segment" | "min_spend" | "no_opt_out";
  value?: string | number | boolean;
}

export interface AutomationAction {
  kind: "send_message" | "issue_coupon" | "add_segment" | "add_note" | "tag_vip";
  channels?: string[];
  template?: string;
  couponId?: string;
  segmentId?: string;
  text?: string;
}

/** Human label for the occurrence day (used in occurrence-scoped campaigns). */
function scheduledDayLabel(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function evaluateConditions(
  conditions: AutomationCondition[],
  customer: {
    id: string;
    marketingConsent: boolean;
    optOut: boolean;
    hotelId: string;
    visits: { amount: number | null }[];
    segments: { segmentId: string }[];
  },
): Promise<boolean> {
  for (const cond of conditions) {
    switch (cond.kind) {
      case "marketing_consent":
        if (customer.marketingConsent !== Boolean(cond.value)) return false;
        break;
      case "no_opt_out":
        if (customer.optOut) return false;
        break;
      case "min_visits":
        if (customer.visits.length < Number(cond.value ?? 0)) return false;
        break;
      case "min_spend": {
        const spend = customer.visits.reduce((s, v) => s + (v.amount ?? 0), 0);
        if (spend < Number(cond.value ?? 0)) return false;
        break;
      }
      case "segment": {
        if (!customer.segments.some((s) => s.segmentId === cond.value)) return false;
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

async function ensureExecution(
  automationId: string,
  customerId: string,
  hotelId: string,
  trigger: string,
  scheduledAt: Date,
) {
  // Idempotency: if an execution for (automation, customer, trigger) already
  // exists within a STRICT <24h window of this occurrence, skip. (The window
  // is half-open — `gt`/`lt`, not `gte`/`lte` — because an inclusive ±24h
  // window collapsed CONSECUTIVE-DAY occurrences: day N+1's scheduledAt is
  // exactly day N's + 24h and was silently deduped, so daily triggers only
  // ever fired once. The check-then-create is still best-effort under
  // concurrent scans; a rare duplicate row is harmless because the send
  // pipeline's (campaignId, customerId, channel) reservation dedupes the
  // actual message.)
  const existing = await db.automationExecution.findFirst({
    where: {
      automationId,
      customerId,
      trigger,
      scheduledAt: {
        gt: new Date(scheduledAt.getTime() - DAY_MS),
        lt: new Date(scheduledAt.getTime() + DAY_MS),
      },
    },
  });
  if (existing) return existing;

  return db.automationExecution.create({
    data: {
      automationId,
      customerId,
      hotelId,
      trigger,
      scheduledAt,
      status: "PENDING",
    },
  });
}

/**
 * Execute a single AutomationExecution row.
 *
 * AUDIT FIX (F01 — cross-tenant automation execution): the execution lookup is
 * now TENANT-SCOPED. Callers that act on behalf of an authenticated hotel MUST
 * pass that hotel's id via `opts.hotelId` — a foreign execution id is treated
 * exactly like a missing one (404 semantics, `ok:false`). The worker and the
 * scan loop, which legitimately process executions for many hotels, call
 * without `hotelId` but still scope every write by the row's own tenant.
 *
 * BUG-4 fix — ATOMIC CLAIM: the PROCESSING transition is a guarded
 * updateMany on the observed status (CAS), not an unguarded update. Two
 * workers draining the same PENDING list can no longer BOTH execute — the
 * DB serializes the claim and the loser sees count 0. Rows stuck PROCESSING
 * (crash mid-run) are reclaimed to PENDING by the sweep's stale reaper.
 */
export async function runExecution(
  executionId: string,
  now = new Date(),
  opts?: { hotelId?: string | null },
): Promise<{ ok: boolean; reason?: string }> {
  const execution = await db.automationExecution.findUnique({
    where: { id: executionId },
    include: {
      automation: true,
      customer: {
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          hotelId: true,
          marketingConsent: true,
          optOut: true,
          segments: { select: { segmentId: true } },
          visits: { select: { amount: true } },
        },
      },
    },
  });
  if (!execution || !execution.automation || !execution.customer) {
    return { ok: false, reason: "Execution or related records missing." };
  }
  // AUDIT FIX (F01): hard tenant guard — when the caller represents a specific
  // hotel (session/UI retry path), the execution MUST belong to that hotel.
  // UUID guessability is not an authorization mechanism.
  if (opts?.hotelId && execution.hotelId !== opts.hotelId) {
    return { ok: false, reason: "Execution not found." };
  }
  if (execution.status === "SUCCESS") return { ok: true };
  // BUG-4: a PROCESSING row is owned by another worker (or is stale and will
  // be reaped) — never double-execute it.
  if (execution.status === "PROCESSING") {
    return { ok: false, reason: "Execution is already running." };
  }

  try {
    // ATOMIC CLAIM (CAS): only the runner whose updateMany wins (count === 1)
    // may execute. Manual retries of FAILED rows are allowed (status included
    // in the guard); concurrent claims of the same row still yield one winner.
    const claim = await db.automationExecution.updateMany({
      where: { id: executionId, status: { in: ["PENDING", "FAILED"] } },
      data: { status: "PROCESSING", executedAt: now },
    });
    if (claim.count !== 1) {
      return { ok: false, reason: "Execution was already claimed by another runner." };
    }

    const automation = execution.automation;
    const customer = execution.customer;
    const hotelId = customer.hotelId;

    // Evaluate conditions
    let conditions: AutomationCondition[] = [];
    try {
      conditions = automation.conditions ? JSON.parse(automation.conditions) : [];
    } catch {
      conditions = [];
    }
    const ok = await evaluateConditions(conditions, customer);
    if (!ok) {
      await db.automationExecution.update({
        where: { id: executionId },
        data: { status: "CANCELLED", failureReason: "CONDITIONS_NOT_MET" },
      });
      return { ok: false, reason: "Conditions not met." };
    }

    // Execute actions
    let actions: AutomationAction[] = [];
    try {
      actions = automation.actions ? JSON.parse(automation.actions) : [];
    } catch {
      actions = [];
    }

    const summary: string[] = [];

    for (const action of actions) {
      switch (action.kind) {
        case "send_message": {
          // AUDIT FIX (F12): the auto campaign is now SCOPED TO THIS
          // OCCURRENCE (rule + trigger + occurrence day). Previously every
          // occurrence of a rule reused ONE lifetime campaign named
          // `Auto: <rule>` and the (campaignId, customerId, channel) unique
          // constraint silently suppressed every later occurrence — next
          // year's birthday, the next qualifying inactivity window, etc.
          // never received a second message. Occurrence-scoped campaigns keep
          // the guarantee that a RETRY of the SAME execution cannot
          // double-send (same campaign → same reservation), while a genuine
          // NEW occurrence gets its own campaign and can message again.
          const occurrenceName = `Auto: ${automation.name} · ${execution.trigger} · ${scheduledDayLabel(execution.scheduledAt)}`;
          let campaign = await db.campaign.findFirst({
            where: { hotelId, name: occurrenceName },
          });
          if (!campaign) {
            campaign = await db.campaign.create({
              data: {
                hotelId,
                name: occurrenceName,
                description: `Generated by automation rule: ${automation.name} (occurrence ${scheduledDayLabel(execution.scheduledAt)})`,
                status: "ACTIVE",
                scheduleType: "AUTOMATED",
                channels: JSON.stringify(action.channels ?? ["WHATSAPP"]),
                messageTemplate:
                  action.template ??
                  automation.messageTemplate ??
                  "Hi {{name}}, we have an offer for you at {{hotel_name}}!",
                offer: automation.offer ?? null,
                couponId: automation.couponId ?? null,
              },
            });
          }
          const hotel = await db.hotel.findUnique({ where: { id: hotelId } });
          const result = await executeCampaignSend(
            campaign.id,
            { hotelId, hotelName: hotel?.name ?? "Your Hotel" },
            [customer.id],
          );
          if (result.ok) {
            summary.push(
              `sent:${result.summary.sent + result.summary.simulated}/failed:${result.summary.failed}/skipped:${result.summary.skipped}`,
            );
          } else {
            summary.push(`send_failed:${result.error}`);
          }
          break;
        }
        case "issue_coupon": {
          if (action.couponId) {
            // Mark coupon as attached to the customer via TimelineEvent
            await db.timelineEvent.create({
              data: {
                hotelId,
                customerId: customer.id,
                type: "COUPON_ISSUED",
                label: "Coupon issued by automation",
                detail: action.couponId,
              },
            });
            summary.push("coupon_issued");
          }
          break;
        }
        case "add_segment": {
          if (action.segmentId) {
            const seg = await db.segment.findFirst({ where: { id: action.segmentId, hotelId } });
            if (seg) {
              try {
                await db.segmentMember.create({
                  data: { segmentId: seg.id, customerId: customer.id, source: "MANUAL" },
                });
                summary.push("segment_added");
              } catch {
                // already a member — idempotent
              }
            }
          }
          break;
        }
        case "add_note": {
          await db.timelineEvent.create({
            data: {
              hotelId,
              customerId: customer.id,
              type: "ADMIN_NOTE",
              label: "Note added by automation",
              detail: action.text ?? "",
            },
          });
          summary.push("note_added");
          break;
        }
        case "tag_vip": {
          await db.customer.update({ where: { id: customer.id }, data: { vip: true } });
          summary.push("tagged_vip");
          break;
        }
      }
    }

    await db.automationExecution.update({
      where: { id: executionId },
      data: {
        status: "SUCCESS",
        executedAt: now,
        result: JSON.stringify({ actions: summary }),
      },
    });
    await db.automationRule.update({
      where: { id: automation.id },
      data: { runsCount: { increment: 1 }, lastRunAt: now },
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await db.automationExecution.update({
      where: { id: executionId },
      data: { status: "FAILED", retryCount: { increment: 1 }, failureReason: message },
    });
    return { ok: false, reason: message };
  }
}

/**
 * Scan a hotel for customers who match the trigger conditions today and
 * queue executions for them. Designed to be called on a schedule.
 */
export async function scanAutomationTriggers(
  hotelId: string,
  hotelName: string,
  now = new Date(),
): Promise<{
  queued: number;
  byTrigger: Record<string, number>;
  details: { automationId: string; name: string; trigger: string; matched: number }[];
}> {
  // Calendar-day matching uses the hotel's timezone (lib/timezone.ts).
  const tz = await hotelTimezone(hotelId);
  const rules = await db.automationRule.findMany({
    where: { hotelId, status: "ACTIVE" },
  });
  const result = {
    queued: 0,
    byTrigger: {} as Record<string, number>,
    details: [] as { automationId: string; name: string; trigger: string; matched: number }[],
  };

  for (const rule of rules) {
    const matched: { customerId: string; triggerDate: Date }[] = [];
    const triggerDate = now;

    switch (rule.trigger) {
      case "HOTEL_CHECKOUT": {
        const target = new Date(now.getTime() - rule.waitDays * DAY_MS);
        const visits = await db.visit.findMany({
          where: { hotelId, checkout: { not: null } },
          select: { customerId: true, checkout: true },
        });
        for (const v of visits) {
          if (v.checkout && sameZonedDay(v.checkout, target, tz)) {
            matched.push({ customerId: v.customerId, triggerDate });
          }
        }
        break;
      }
      case "RESTAURANT_VISIT": {
        const target = new Date(now.getTime() - rule.waitDays * DAY_MS);
        const rvs = await db.restaurantVisit.findMany({
          where: { hotelId },
          select: { customerId: true, visitDate: true },
        });
        for (const rv of rvs) {
          if (sameZonedDay(rv.visitDate, target, tz)) {
            matched.push({ customerId: rv.customerId, triggerDate });
          }
        }
        break;
      }
      case "INACTIVE_7":
      case "INACTIVE_15":
      case "INACTIVE_30": {
        const days = rule.trigger === "INACTIVE_7" ? 7 : rule.trigger === "INACTIVE_15" ? 15 : 30;
        const cutoff = new Date(now.getTime() - days * DAY_MS);
        // AUDIT FIX (F11): inactivity must consider ALL activity channels, not
        // only hotel room stays. A customer who dined today is ACTIVE even if
        // they never booked a room — previously the INACTIVE_* triggers still
        // matched them and sent win-back messages to someone who came in
        // this morning. Last activity = max(last hotel check-in, last
        // restaurant visit date).
        const customers = await db.customer.findMany({
          where: { hotelId, status: "ACTIVE" },
          select: {
            id: true,
            visits: { select: { checkin: true }, orderBy: { checkin: "desc" }, take: 1 },
            restaurantVisits: {
              select: { visitDate: true },
              orderBy: { visitDate: "desc" },
              take: 1,
            },
          },
        });
        for (const c of customers) {
          const lastStay = c.visits[0]?.checkin ?? null;
          const lastDine = c.restaurantVisits[0]?.visitDate ?? null;
          const lastActivity =
            lastStay && lastDine
              ? lastStay > lastDine
                ? lastStay
                : lastDine
              : (lastStay ?? lastDine);
          if (!lastActivity || lastActivity < cutoff) {
            matched.push({ customerId: c.id, triggerDate });
          }
        }
        break;
      }
      case "BIRTHDAY": {
        const today = now;
        const customers = await db.customer.findMany({
          where: { hotelId, birthday: { not: null } },
          select: { id: true, birthday: true },
        });
        for (const c of customers) {
          if (!c.birthday) continue;
          if (
            c.birthday.getMonth() === today.getMonth() &&
            c.birthday.getDate() === today.getDate()
          ) {
            matched.push({ customerId: c.id, triggerDate });
          }
        }
        break;
      }
      case "ANNIVERSARY": {
        const today = now;
        const customers = await db.customer.findMany({
          where: { hotelId, anniversary: { not: null } },
          select: { id: true, anniversary: true },
        });
        for (const c of customers) {
          if (!c.anniversary) continue;
          if (
            c.anniversary.getMonth() === today.getMonth() &&
            c.anniversary.getDate() === today.getDate()
          ) {
            matched.push({ customerId: c.id, triggerDate });
          }
        }
        break;
      }
      case "VIP_THRESHOLD": {
        const customers = await db.customer.findMany({
          where: { hotelId, vip: true },
          select: { id: true },
        });
        for (const c of customers) {
          matched.push({ customerId: c.id, triggerDate });
        }
        break;
      }
      case "OFFER_UNUSED": {
        // Customers who were sent a coupon campaign but never redeemed
        const sent = await db.campaignMessage.findMany({
          where: { hotelId, status: { in: ["SENT", "SIMULATED"] } },
          select: { customerId: true, campaign: { select: { couponId: true } } },
        });
        const redeemed = await db.couponRedemption.findMany({
          where: { hotelId },
          select: { customerId: true },
        });
        const redeemedSet = new Set(redeemed.map((r) => r.customerId));
        for (const s of sent) {
          if (s.campaign?.couponId && !redeemedSet.has(s.customerId)) {
            matched.push({ customerId: s.customerId, triggerDate });
          }
        }
        break;
      }
      case "REPEAT_VISIT": {
        // AUDIT FIX (F11): a repeat visit means a repeat interaction with the
        // business — restaurant bills count too, not only room stays.
        const customers = await db.customer.findMany({
          where: { hotelId },
          select: {
            id: true,
            visits: { select: { checkin: true }, orderBy: { checkin: "asc" } },
            restaurantVisits: { select: { visitDate: true }, orderBy: { visitDate: "asc" } },
          },
        });
        for (const c of customers) {
          const lastStay = c.visits.length ? c.visits[c.visits.length - 1].checkin : null;
          const lastDine = c.restaurantVisits.length
            ? c.restaurantVisits[c.restaurantVisits.length - 1].visitDate
            : null;
          const lastActivity =
            lastStay && lastDine
              ? lastStay > lastDine
                ? lastStay
                : lastDine
              : (lastStay ?? lastDine);
          if (
            c.visits.length + c.restaurantVisits.length >= 2 &&
            lastActivity &&
            sameZonedDay(lastActivity, now, tz)
          ) {
            matched.push({ customerId: c.id, triggerDate });
          }
        }
        break;
      }
      default:
        // Event-based triggers (CAMPAIGN_OPENED/CLICKED/REPLIED) are queued live by lead-scoring.ts
        continue;
    }

    for (const { customerId, triggerDate } of matched) {
      await ensureExecution(rule.id, customerId, hotelId, rule.trigger, triggerDate);
      result.queued += 1;
      result.byTrigger[rule.trigger] = (result.byTrigger[rule.trigger] ?? 0) + 1;
    }
    result.details.push({
      automationId: rule.id,
      name: rule.name,
      trigger: rule.trigger,
      matched: matched.length,
    });
  }

  await logAudit({
    hotelId,
    action: "AUTOMATION_SCAN",
    entityType: "automation_engine",
    metadata: { queued: result.queued, byTrigger: result.byTrigger },
  });

  // Process queued executions immediately (idempotent — safe to retry)
  const pending = await db.automationExecution.findMany({
    where: { hotelId, status: "PENDING", scheduledAt: { lte: now } },
    select: { id: true },
    take: 100,
  });
  for (const p of pending) {
    await runExecution(p.id, now);
  }

  return result;
}

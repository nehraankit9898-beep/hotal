/**
 * Phase 15 — retention engine: real restaurant events drive real workflows.
 *
 * RESTAURANT_BILL_PAID job (durable outbox, exactly-once per bill):
 *   1. Legacy visit aggregate (Phase 5 compatibility) + loyalty award
 *      (recordRestaurantVisit internally awards idempotently per visit id).
 *   2. Referral qualification (referee's first qualifying paid bill).
 *   3. Thank-you + consent-safe review request email — ONLY when the
 *      customer holds marketing consent; opted-out customers are never
 *      contacted; the configured reviewUrl is the tenant's own verified URL.
 *   4. Automation trigger feed — the Phase 11 scheduler's 15-minute
 *      restaurant-visit scan picks the recorded visit up (no parallel
 *      messaging engine is created here).
 *
 * OWNER_REPORT job: business-day digest computed from bills/payments/refunds
 * and emailed to the configured recipients (tenant timezone aware).
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { sendEmailWithRetry } from "@/lib/providers/email";
import { recordRestaurantVisit } from "@/lib/restaurant";
import { qualifyReferralForBill } from "@/lib/referrals";
import { consumeStockForBill } from "@/lib/inventory";
import type { JobContext, JobOutcome } from "@/lib/jobs/handlers";

const VISIT_REF_PREFIX = "billId:";

export const RESTAURANT_BILL_PAID_JOB = "RESTAURANT_BILL_PAID";
export const OWNER_REPORT_JOB = "OWNER_REPORT";

/* ------------------------------------------------------------------ */
/* RESTAURANT_BILL_PAID                                                */
/* ------------------------------------------------------------------ */

export async function runRestaurantBillPaid(ctx: JobContext): Promise<JobOutcome> {
  const billId = String(ctx.payload.billId ?? "");
  const hotelId = String(ctx.payload.hotelId ?? ctx.hotelId ?? "");
  const customerId = ctx.payload.customerId ? String(ctx.payload.customerId) : null;
  const totalMinor = Number(ctx.payload.totalMinor ?? 0);
  if (!billId || !hotelId) {
    return { ok: false, permanent: true, result: { error: "Missing billId/hotelId" } };
  }

  const bill = await db.bill.findUnique({ where: { id: billId } });
  if (!bill) return { ok: false, permanent: true, result: { error: "Bill not found" } };
  // A later refund/void means followups are no longer eligible.
  if (bill.status === "VOID" || bill.status === "REFUNDED") {
    return { ok: true, result: { skipped: `bill_${bill.status.toLowerCase()}` } };
  }

  const outcomes: Record<string, unknown> = {};

  // ---- 1. Legacy visit aggregate + loyalty (idempotent via visit-ref scan).
  if (customerId) {
    const visitRef = `${VISIT_REF_PREFIX}${bill.id}`;
    const existing = await db.restaurantVisit.findFirst({
      where: { hotelId, notes: { contains: visitRef } },
      select: { id: true },
    });
    if (!existing) {
      const table = bill.tableId
        ? await db.diningTable.findUnique({ where: { id: bill.tableId }, select: { number: true } })
        : null;
      const visit = await recordRestaurantVisit({
        hotelId,
        customerId,
        visitDate: bill.paidAt ?? bill.issuedAt,
        tableNumber: table?.number ?? undefined,
        guests: 1,
        orderAmount: totalMinor / 100,
        source: bill.tableId ? "QR_MENU" : "WALK_IN",
        notes: `Paid bill ${bill.billNumber} · ${visitRef}`,
        userId: null,
      });
      outcomes.visitId = visit.id;
      outcomes.loyalty = visit.loyaltyAward ?? null;
    } else {
      outcomes.visitId = existing.id;
      outcomes.visitRecorded = "already";
    }

    // ---- 2. Referral qualification (referee's qualifying bill).
    try {
      const referral = await qualifyReferralForBill(hotelId, customerId, bill.id, totalMinor);
      outcomes.referral = referral.status;
    } catch (err) {
      logger.warn("retention.referral_qualify_failed", {
        billId,
        err: err instanceof Error ? err.message : String(err),
      });
      outcomes.referral = "ERROR";
    }
  }

  // ---- 3. Consent-safe thank-you + review request (email).
  if (customerId) {
    const customer = await db.customer.findUnique({ where: { id: customerId } });
    if (customer?.email && customer.marketingConsent) {
      const settings = await db.hotelSettings.findUnique({ where: { hotelId }, select: { reviewUrl: true } });
      const reviewUrl = settings?.reviewUrl ?? null;

      // Idempotency: one thank-you per bill (audit via TimelineEvent scan).
      const marker = `BILL_THANKYOU:${bill.id}`;
      const already = await db.timelineEvent.findFirst({
        where: { hotelId, customerId, type: "CAMPAIGN_SENT", detail: { contains: marker } },
        select: { id: true },
      });
      if (!already) {
        const hotel = await db.hotel.findUnique({ where: { id: hotelId }, select: { name: true } });
        const html = `
          <p>Hi ${escapeHtml(customer.name)},</p>
          <p>Thank you for dining at <b>${escapeHtml(hotel?.name ?? "our restaurant")}</b>!
          We hope you enjoyed your meal.</p>
          ${
            reviewUrl
              ? `<p>If you have a moment, we'd love your feedback:
                 <a href="${escapeHtml(reviewUrl)}">Leave a review</a>.</p>
                 <p class="muted">You receive this because you opted in to updates.
                 Reply STOP to opt out.</p>`
              : `<p>You receive this because you opted in to updates. Reply STOP to opt out.</p>`
          }`;
        const send = await sendEmailWithRetry({
          to: customer.email,
          subject: `Thank you for dining with us${hotel?.name ? ` — ${hotel.name}` : ""}!`,
          html,
          text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
          kind: "RESTAURANT_THANKYOU",
        });
        outcomes.thankYou = { ok: send.ok, provider: send.provider };
        await db.timelineEvent.create({
          data: {
            hotelId,
            customerId,
            type: "CAMPAIGN_SENT",
            label: "Bill thank-you",
            detail: `${marker} · email ${send.ok ? "sent" : "FAILED"} · review request: ${reviewUrl ? "included" : "not configured"}`,
          },
        });
      } else {
        outcomes.thankYou = { skipped: "already_sent" };
      }
    } else {
      outcomes.thankYou = { skipped: customer?.email ? "no_consent" : "no_email" };
    }
  }

  // ---- 4. Recipe stock deduction (BILL_PAID basis, exactly-once fence).
  try {
    const stock = await consumeStockForBill(hotelId, bill.id);
    outcomes.stock = stock;
  } catch (err) {
    logger.warn("retention.stock_deduction_failed", {
      billId,
      err: err instanceof Error ? err.message : String(err),
    });
    outcomes.stock = "ERROR";
  }

  return { ok: true, result: outcomes };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ------------------------------------------------------------------ */
/* OWNER_REPORT (daily/weekly digest)                                  */
/* ------------------------------------------------------------------ */

export interface DayReport {
  date: string;
  timezone: string;
  bills: number;
  grossMinor: number;
  discountMinor: number;
  taxMinor: number;
  netSalesMinor: number;
  refundMinor: number;
  paymentsByMethod: Record<string, number>;
  newCustomers: number;
  failedJobs: number;
}

export async function computeDayReport(hotelId: string, dateLocal: string, tz: string): Promise<DayReport> {
  const { start, end } = localDayBounds(dateLocal, tz);
  const [bills, payments, refunds, newCustomers, failedJobs] = await Promise.all([
    db.bill.findMany({
      where: { hotelId, issuedAt: { gte: start, lt: end }, status: { not: "VOID" } },
      select: { subtotalMinor: true, discountMinor: true, taxMinor: true },
    }),
    db.billPayment.findMany({
      where: { hotelId, paidAt: { gte: start, lt: end }, status: { in: ["RECORDED", "CAPTURED"] } },
      select: { method: true, amountMinor: true },
    }),
    db.billRefund.findMany({
      where: { hotelId, createdAt: { gte: start, lt: end }, type: "REFUND" },
      select: { amountMinor: true },
    }),
    db.customer.count({ where: { hotelId, createdAt: { gte: start, lt: end } } }),
    db.backgroundJob.count({ where: { hotelId, status: "FAILED", updatedAt: { gte: start, lt: end } } }),
  ]);
  const paymentsByMethod: Record<string, number> = {};
  for (const p of payments) paymentsByMethod[p.method] = (paymentsByMethod[p.method] ?? 0) + p.amountMinor;
  return {
    date: dateLocal,
    timezone: tz,
    bills: bills.length,
    grossMinor: bills.reduce((s, b) => s + b.subtotalMinor, 0),
    discountMinor: bills.reduce((s, b) => s + b.discountMinor, 0),
    taxMinor: bills.reduce((s, b) => s + b.taxMinor, 0),
    netSalesMinor: bills.reduce((s, b) => s + b.subtotalMinor - b.discountMinor, 0),
    refundMinor: refunds.reduce((s, r) => s + r.amountMinor, 0),
    paymentsByMethod,
    newCustomers,
    failedJobs,
  };
}

/** Local-day bounds using Intl (DST-safe, no external deps). */
export function localDayBounds(dateStr: string, tz: string): { start: Date; end: Date } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const offsetAt = (at: Date): number => {
    const parts = fmt.formatToParts(at);
    const y = Number(parts.find((p) => p.type === "year")?.value);
    const m = Number(parts.find((p) => p.type === "month")?.value);
    const d = Number(parts.find((p) => p.type === "day")?.value);
    return Date.UTC(y, m - 1, d) - Math.floor(at.getTime() / 1000) * 1000;
  };
  const [y, m, d] = dateStr.split("-").map(Number);
  const probe = Date.UTC(y, m - 1, d, 12, 0, 0);
  const offset = offsetAt(new Date(probe));
  const startMs = Date.UTC(y, m - 1, d) - offset;
  const endOffset = offsetAt(new Date(startMs + 24 * 3600_000 - 60_000));
  return { start: new Date(startMs), end: new Date(startMs + 24 * 3600_000 - endOffset) };
}

export async function runOwnerReport(ctx: JobContext): Promise<JobOutcome> {
  const hotelId = String(ctx.payload.hotelId ?? ctx.hotelId ?? "");
  if (!hotelId) return { ok: false, permanent: true, result: { error: "Missing hotelId" } };

  const hotel = await db.hotel.findUnique({ where: { id: hotelId }, select: { name: true, timezone: true } });
  if (!hotel) return { ok: false, permanent: true, result: { error: "Hotel not found" } };
  const tz = hotel.timezone || "Asia/Kolkata";
  const schedule = await db.reportSchedule.findUnique({ where: { hotelId } });
  if (!schedule || !schedule.active) {
    return { ok: true, result: { skipped: "schedule_inactive" } };
  }

  let recipients: string[] = [];
  try {
    recipients = JSON.parse(schedule.recipients ?? "[]");
  } catch {
    recipients = [];
  }
  recipients = recipients.filter((r) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r));
  if (recipients.length === 0) {
    await db.reportSchedule.update({
      where: { hotelId },
      data: { lastSentAt: new Date(), lastResult: "SKIPPED_NO_RECIPIENTS" },
    });
    return { ok: true, result: { skipped: "no_recipients" } };
  }

  // The report covers the previous LOCAL business day.
  const nowLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const [y, m, d] = nowLocal.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  const dateStr = prev.toISOString().slice(0, 10);

  const report = await computeDayReport(hotelId, dateStr, tz);
  const inr = (m: number) => `₹${(m / 100).toFixed(2)}`;
  const methodRows = Object.entries(report.paymentsByMethod)
    .map(([k, v]) => `<tr><td>${k}</td><td style="text-align:right">${inr(v)}</td></tr>`)
    .join("");

  const html = `
    <h2>${escapeHtml(hotel.name)} — business day ${report.date} (${tz})</h2>
    <table border="0" cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
      <tr><td>Bills</td><td style="text-align:right"><b>${report.bills}</b></td></tr>
      <tr><td>Net sales</td><td style="text-align:right"><b>${inr(report.netSalesMinor)}</b></td></tr>
      <tr><td>Discounts</td><td style="text-align:right">${inr(report.discountMinor)}</td></tr>
      <tr><td>Tax collected</td><td style="text-align:right">${inr(report.taxMinor)}</td></tr>
      <tr><td>Refunds</td><td style="text-align:right">${inr(report.refundMinor)}</td></tr>
      ${methodRows}
      <tr><td>New customers</td><td style="text-align:right">${report.newCustomers}</td></tr>
      <tr><td>Failed jobs</td><td style="text-align:right">${report.failedJobs}</td></tr>
    </table>
    <p style="color:#666;font-size:12px">Computed from invoices, payment allocations and refunds for the tenant-local business day. Times are ${tz}.</p>`;

  let failures = 0;
  for (const to of recipients) {
    const res = await sendEmailWithRetry({
      to,
      subject: `[RestroLoop] ${hotel.name} — daily report ${report.date}`,
      html,
      text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      kind: "OWNER_DAILY_REPORT",
    });
    if (!res.ok) failures += 1;
  }

  await db.reportSchedule.update({
    where: { hotelId },
    data: {
      lastSentAt: new Date(),
      lastResult: failures === 0 ? `SENT(${recipients.length})` : `PARTIAL(${recipients.length - failures}/${recipients.length})`,
    },
  });
  return { ok: failures === 0, result: { date: report.date, recipients: recipients.length, failures } };
}

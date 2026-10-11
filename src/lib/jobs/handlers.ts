/**
 * Phase 7 — background job handlers. Each handler is idempotent or protected
 * by DB-level uniqueness so retries / worker restarts never double-apply.
 */

import fs from "fs";
import path from "path";
import { createHmac, timingSafeEqual } from "crypto";

import { logger } from "@/lib/logger";
import { db } from "@/lib/db";
import { executeCampaignSend } from "@/lib/campaigns";
import { buildCustomersCsv } from "@/lib/export-customers";
import { getAuthSecret } from "@/lib/config";
import { processPaymentConfirmation, PAYMENT_CONFIRMED_JOB } from "@/lib/saas/billing";
import { releaseUsage } from "@/lib/saas/limits";
import { runRestaurantBillPaid, runOwnerReport } from "@/lib/retention";

export interface JobContext {
  jobId: string;
  type: string;
  payload: Record<string, unknown>;
  hotelId: string | null;
  createdBy: string | null;
}

export interface JobOutcome {
  ok: boolean;
  result?: Record<string, unknown>;
  /** Permanent validation error — do not retry (dead-letter immediately). */
  permanent?: boolean;
}

/** Export files older than this are no longer downloadable (and are purged). */
export const EXPORT_FILE_TTL_HOURS = 24;

/* ------------------------------------------------------------------ */
/* CAMPAIGN_SEND — delegated to the reserve-then-send pipeline         */
/* ------------------------------------------------------------------ */

async function runCampaignSend(ctx: JobContext): Promise<JobOutcome> {
  const campaignId = String(ctx.payload.campaignId ?? "");
  const hotelId = String(ctx.payload.hotelId ?? ctx.hotelId ?? "");
  let hotelName = String(ctx.payload.hotelName ?? "");
  const userId = String(ctx.payload.userId ?? ctx.createdBy ?? "");

  if (!campaignId || !hotelId) {
    return {
      ok: false,
      permanent: true,
      result: { error: "Missing campaignId/hotelId in job payload" },
    };
  }

  // BUG-6 DB fallback: queued jobs created before the hotelName field was
  // added to payloads (or jobs whose payload lost it) must not render
  // templates with an empty {{hotel_name}} ("thank you for staying at !").
  if (!hotelName) {
    const hotel = await db.hotel.findUnique({
      where: { id: hotelId },
      select: { name: true },
    });
    hotelName = hotel?.name ?? "Our Hotel";
  }

  // executeCampaignSend is idempotent: reserve-then-send with DB-unique
  // (campaignId, customerId, channel) + deterministic idempotencyKey means a
  // retried job can never send a duplicate message to the same recipient.
  const result = await executeCampaignSend(campaignId, { hotelId, hotelName, userId });
  if (!result.ok) {
    // Send-blocked results (paused, empty audience, consent) are permanent.
    return { ok: false, permanent: true, result: { error: result.error, status: result.status } };
  }
  return { ok: true, result: { summary: result.summary } };
}

/* ------------------------------------------------------------------ */
/* CSV_EXPORT — stream to disk, then serve via authenticated download  */
/* ------------------------------------------------------------------ */

export function exportDir(): string {
  const dir = process.env.EXPORT_DIR
    ? path.resolve(process.env.EXPORT_DIR)
    : path.join(process.cwd(), "var", "exports");
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  return dir;
}

/**
 * Resolve the on-disk path of an export file, rejecting anything that is not
 * a bare, extension-checked filename (path traversal defense). The stored
 * filename comes from the job RESULT row — never from request input — but the
 * resolver is kept strict so a tampered/legacy result can never escape the
 * exports directory.
 */
export function resolveExportFilePath(filename: string): string | null {
  if (!/^[A-Za-z0-9_-]+\.[a-z]{2,4}$/.test(filename)) return null; // no slashes, dots, or traversal
  const dir = exportDir();
  const resolved = path.resolve(dir, filename);
  if (!resolved.startsWith(dir + path.sep)) return null; // must live INSIDE the exports dir
  return resolved;
}

/** HMAC-signed download token so URLs cannot be guessed or tampered with. */
export function exportDownloadToken(jobId: string): string {
  return createHmac("sha256", getAuthSecret()).update(`export:${jobId}`).digest("base64url");
}

export function verifyExportToken(jobId: string, token: string): boolean {
  const expected = Buffer.from(exportDownloadToken(jobId));
  const provided = Buffer.from(token);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

async function runCsvExport(ctx: JobContext): Promise<JobOutcome> {
  const hotelId = String(ctx.payload.hotelId ?? ctx.hotelId ?? "");
  if (!hotelId) {
    return { ok: false, permanent: true, result: { error: "Missing hotelId in job payload" } };
  }

  let csv: string;
  let rows: number;
  try {
    ({ csv, rows } = await buildCustomersCsv(hotelId));
  } catch (err) {
    // AUDIT FIX (quota): the export reservation was taken at REQUEST time.
    // A build failure means the tenant got NOTHING for the reserved slot —
    // give it back (guarded decrement, never below zero) so server-side
    // failures do not silently burn the monthly export quota.
    await releaseUsage(hotelId, "exports").catch(() => undefined);
    return {
      ok: false,
      permanent: true,
      result: {
        error: `CSV build failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
      },
    };
  }
  const dir = exportDir();
  // AUDIT FIX (atomic publish): write to a per-attempt temp file first, then
  // RENAME into place. rename(2) is atomic on the same filesystem, so a crash
  // (or a concurrent retry after lease loss) can never leave a PARTIAL file
  // under the final name — readers see either the old complete file or the
  // new complete file, never a half-written one.
  const finalPath = path.join(dir, `${ctx.jobId}.csv`);
  const tmpPath = path.join(dir, `.tmp-${ctx.jobId}-${Date.now().toString(36)}.csv`);
  // 0640: owner (UID 1001, the shared app identity in Docker) read/write;
  // group read; NO world access. The web container runs the same UID/GID.
  fs.writeFileSync(tmpPath, csv, { mode: 0o640 });
  try {
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }

  return {
    ok: true,
    result: {
      rows,
      file: path.basename(finalPath),
      downloadToken: exportDownloadToken(ctx.jobId),
      sizeBytes: Buffer.byteLength(csv),
      generatedAt: new Date().toISOString(),
    },
  };
}

/* ------------------------------------------------------------------ */
/* PAYMENT_CONFIRMED — outbox recovery for payment follow-ups          */
/* ------------------------------------------------------------------ */

/**
 * Outbox consumer (audit fix billing-1): markPaymentPaid flips PENDING→PAID
 * and enqueues this job in the SAME transaction. If the inline follow-up
 * (coupon redemption + subscription activation) succeeded already, this is a
 * no-op double-check; if the process crashed in between, THIS is the recovery
 * path that completes the confirmation. processPaymentConfirmation is
 * idempotent, so a retry after a partial failure resumes exactly where the
 * crashed run stopped.
 */
async function runPaymentConfirmed(ctx: JobContext): Promise<JobOutcome> {
  const paymentId = String(ctx.payload.paymentId ?? "");
  if (!paymentId) {
    return { ok: false, permanent: true, result: { error: "Missing paymentId in job payload" } };
  }
  const result = await processPaymentConfirmation({
    paymentId,
    adminUserId: (ctx.payload.adminUserId as string | undefined) ?? ctx.createdBy ?? undefined,
    reason: (ctx.payload.reason as string | undefined) ?? "outbox-recovery",
  });
  if (!result.ok) {
    // "Payment is not PAID" is permanent (status regressed — e.g. refunded
    // before the outbox ran); anything else is retryable.
    const permanent =
      (result.error ?? "").includes("not PAID") || (result.error ?? "").includes("not found");
    return {
      ok: false,
      permanent,
      result: { error: result.error ?? "Payment confirmation follow-up failed" },
    };
  }
  return { ok: true, result: { alreadyComplete: Boolean(result.alreadyComplete) } };
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                          */
/* ------------------------------------------------------------------ */

export async function runJob(ctx: JobContext): Promise<JobOutcome> {
  switch (ctx.type) {
    case "CAMPAIGN_SEND":
      return runCampaignSend(ctx);
    case "CSV_EXPORT":
      return runCsvExport(ctx);
    case PAYMENT_CONFIRMED_JOB:
      return runPaymentConfirmed(ctx);
    // Phase 14/15 — restaurant bill-paid followups + owner reports
    case "RESTAURANT_BILL_PAID":
      return runRestaurantBillPaid(ctx);
    case "OWNER_REPORT":
      return runOwnerReport(ctx);
    default:
      return { ok: false, permanent: true, result: { error: `Unknown job type: ${ctx.type}` } };
  }
}

/** Delete export files older than TTL (default 24 h). Called by the worker. */
export function cleanupExpiredExports(ttlHours = 24): number {
  const dir = exportDir();
  const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".csv")) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.rmSync(full);
          removed += 1;
        }
      } catch {
        /* file vanished — fine */
      }
    }
  } catch {
    /* dir missing — fine */
  }
  if (removed > 0) logger.info("exports.cleaned", { removed });
  return removed;
}

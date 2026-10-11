/**
 * Phase 7 — persistent background job queue (spec §15, §19, §28).
 *
 * A database-backed queue (works on SQLite dev and PostgreSQL prod) with:
 * - job IDs + typed payloads
 * - optimistic worker locking (status-checked atomic updateMany → safe with
 *   concurrent workers on Postgres; on SQLite the single-writer model serializes)
 * - LEASE FENCING: every claim mints a one-time lease id stored in `lockedBy`
 *   (`<workerId>#<random>`). Completion/failure/heartbeat updates are fenced on
 *   that lease, so a stale worker can never overwrite a newer claim (Phase 10
 *   audit fix — a slow worker that lost its lease mid-job cannot clobber the
 *   requeued/dead-lettered state written by the new owner).
 * - LEASE HEARTBEAT: long-running jobs renew `lockedAt` so the 10-minute
 *   staleness TTL does not reclaim a healthy, still-running job.
 * - retry policy with exponential backoff + max attempts
 * - dead-letter state (status FAILED with lastError) after max attempts,
 *   including on STALE RECOVERY: a job whose attempts are exhausted is
 *   dead-lettered, never requeued (audit fix — recoverStaleJobs used to
 *   requeue forever, inflating `attempts` without bound).
 * - cancellation + progress/result summary
 *
 * Handlers live in `src/lib/jobs/handlers.ts`; the long-running consumer is
 * `scripts/worker.ts`. Never send hundreds of messages inside one HTTP request.
 */

import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

export type JobType = "CAMPAIGN_SEND" | "CSV_EXPORT" | "PAYMENT_CONFIRMED";

export interface EnqueueOptions {
  hotelId?: string | null;
  createdBy?: string | null;
  runAt?: Date;
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  hotelId: string | null;
  createdBy: string | null;
  /** Opaque lease identifier (`workerId#token`) — required for fenced updates. */
  leaseId: string;
}

/** How long a RUNNING job may hold its lock (without heartbeat renewal). */
export const JOB_LOCK_TTL_MS = 10 * 60 * 1000;

/** How often a worker renews the lease of a long-running job. */
export const JOB_HEARTBEAT_MS = 60 * 1000;

/** Backoff before the Nth retry (attempt = 1-based try that just failed). */
export function retryDelayMs(attempt: number): number {
  return Math.min(Math.pow(2, attempt) * 60 * 1000, 15 * 60 * 1000); // 2m, 4m, 8m … max 15m
}

/** Enqueue a job. Returns the job id. */
export async function enqueueJob(
  type: JobType,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<string> {
  const job = await db.backgroundJob.create({
    data: {
      type,
      payload: JSON.stringify(payload),
      hotelId: opts.hotelId ?? null,
      createdBy: opts.createdBy ?? null,
      runAt: opts.runAt ?? new Date(),
      maxAttempts: opts.maxAttempts ?? 3,
    },
    select: { id: true },
  });
  logger.info("queue.enqueued", { jobId: job.id, type });
  return job.id;
}

/** Mint a fresh lease identifier for one claim of one job. */
function newLeaseId(workerId: string): string {
  return `${workerId}#${randomBytes(8).toString("hex")}`;
}

/**
 * Claim the next runnable job (QUEUED, runAt due). The status re-check inside
 * the same update guarantees only one worker wins a given job.
 */
export async function claimNextJob(workerId: string): Promise<ClaimedJob | null> {
  for (let i = 0; i < 5; i++) {
    const candidate = await db.backgroundJob.findFirst({
      where: { status: "QUEUED", runAt: { lte: new Date() } },
      orderBy: [{ runAt: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        type: true,
        payload: true,
        attempts: true,
        maxAttempts: true,
        hotelId: true,
        createdBy: true,
      },
    });
    if (!candidate) return null;

    const leaseId = newLeaseId(workerId);
    const res = await db.backgroundJob.updateMany({
      where: { id: candidate.id, status: "QUEUED" },
      data: {
        status: "RUNNING",
        lockedAt: new Date(),
        lockedBy: leaseId,
        attempts: { increment: 1 },
      },
    });
    if (res.count === 1) {
      return {
        id: candidate.id,
        type: candidate.type as JobType,
        payload: safeParse(candidate.payload),
        attempts: candidate.attempts + 1,
        maxAttempts: candidate.maxAttempts,
        hotelId: candidate.hotelId,
        createdBy: candidate.createdBy,
        leaseId,
      };
    }
    // Lost the race — try the next candidate.
  }
  return null;
}

/**
 * Renew (heartbeat) the lease of a running job so staleness recovery does not
 * reclaim it while the worker is still alive. Returns false when the lease was
 * lost (job reclaimed/dead-lettered elsewhere) — the worker should stop
 * treating its work as authoritative.
 */
export async function renewLease(jobId: string, leaseId: string): Promise<boolean> {
  const res = await db.backgroundJob.updateMany({
    where: { id: jobId, status: "RUNNING", lockedBy: leaseId },
    data: { lockedAt: new Date() },
  });
  return res.count === 1;
}

/**
 * Mark a job completed with a JSON result summary. FENCED on the lease:
 * a stale worker whose lease was reclaimed cannot overwrite the newer state.
 * Returns false when the update did not apply (lease lost).
 */
export async function completeJob(
  jobId: string,
  result: Record<string, unknown>,
  leaseId?: string,
): Promise<boolean> {
  const where = leaseId
    ? { id: jobId, status: "RUNNING" as const, lockedBy: leaseId }
    : { id: jobId, status: "RUNNING" as const };
  const res = await db.backgroundJob.updateMany({
    where,
    data: {
      status: "COMPLETED",
      result: JSON.stringify(result),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
  if (res.count === 1) {
    logger.info("queue.completed", { jobId });
    return true;
  }
  logger.warn("queue.complete_rejected_stale_lease", { jobId });
  return false;
}

/**
 * Handle a job failure: re-queue with exponential backoff while attempts
 * remain, otherwise move to FAILED (dead-letter) with the failure reason.
 * FENCED on the lease so a stale worker cannot fail a job someone else owns.
 */
export async function failJob(
  jobId: string,
  error: unknown,
  leaseId?: string,
): Promise<"retried" | "dead_letter" | "lease_lost"> {
  const message =
    error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  const job = await db.backgroundJob.findUnique({
    where: { id: jobId },
    select: { attempts: true, maxAttempts: true, status: true, lockedBy: true },
  });
  if (!job) return "dead_letter";

  // Fence: only the current lease owner may mutate a RUNNING job.
  if (leaseId && (job.status !== "RUNNING" || job.lockedBy !== leaseId)) {
    logger.warn("queue.fail_rejected_stale_lease", { jobId, status: job.status });
    return "lease_lost";
  }

  if (job.attempts < job.maxAttempts) {
    const runAt = new Date(Date.now() + retryDelayMs(job.attempts));
    const res = await db.backgroundJob.updateMany({
      where: leaseId
        ? { id: jobId, status: "RUNNING", lockedBy: leaseId }
        : { id: jobId, status: "RUNNING" },
      data: { status: "QUEUED", runAt, lockedAt: null, lockedBy: null, lastError: message },
    });
    if (res.count !== 1) {
      logger.warn("queue.fail_rejected_stale_lease", { jobId });
      return "lease_lost";
    }
    logger.warn("queue.retry_scheduled", {
      jobId,
      attempt: job.attempts,
      runAt: runAt.toISOString(),
    });
    return "retried";
  }

  const res = await db.backgroundJob.updateMany({
    where: leaseId
      ? { id: jobId, status: "RUNNING", lockedBy: leaseId }
      : { id: jobId, status: "RUNNING" },
    data: { status: "FAILED", lockedAt: null, lockedBy: null, lastError: message },
  });
  if (res.count !== 1) {
    logger.warn("queue.fail_rejected_stale_lease", { jobId });
    return "lease_lost";
  }
  logger.error("queue.dead_letter", {
    jobId,
    error: message,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
  });
  return "dead_letter";
}

/**
 * Force dead-letter (validation errors — no retry can help). Fenced on the
 * lease when provided. Returns false when the lease was lost.
 */
export async function deadLetterJob(
  jobId: string,
  message: string,
  leaseId?: string,
): Promise<boolean> {
  const res = await db.backgroundJob.updateMany({
    where: leaseId
      ? { id: jobId, status: "RUNNING", lockedBy: leaseId }
      : { id: jobId, status: "RUNNING" },
    data: { status: "FAILED", lockedAt: null, lockedBy: null, lastError: message.slice(0, 500) },
  });
  if (res.count === 1) {
    logger.error("queue.dead_letter", { jobId, error: message.slice(0, 500) });
    return true;
  }
  return false;
}

/** Cancel a QUEUED job (owner or super admin). Returns false if not cancelable. */
export async function cancelJob(jobId: string): Promise<boolean> {
  const res = await db.backgroundJob.updateMany({
    where: { id: jobId, status: "QUEUED" },
    data: { status: "CANCELLED" },
  });
  return res.count === 1;
}

/**
 * Recover stale jobs: RUNNING jobs whose lock expired (no heartbeat renewal)
 * are either re-queued (attempts remain) or DEAD-LETTERED (attempts exhausted).
 * The attempts counter is preserved in both cases — it is never reset, so the
 * retry budget cannot be inflated by repeated crashes. Idempotent — safe to
 * run every tick. The status+lockedAt re-check inside the update keeps racing
 * workers (one renewing its lease, this one recovering) from double-applying.
 */
export async function recoverStaleJobs(): Promise<{ requeued: number; deadLettered: number }> {
  const staleLockCutoff = new Date(Date.now() - JOB_LOCK_TTL_MS);
  const stale = await db.backgroundJob.findMany({
    where: { status: "RUNNING", lockedAt: { lt: staleLockCutoff } },
    select: { id: true, attempts: true, maxAttempts: true },
    take: 50,
  });

  let requeued = 0;
  let deadLettered = 0;
  for (const job of stale) {
    const exhausted = job.attempts >= job.maxAttempts;
    const res = await db.backgroundJob.updateMany({
      where: { id: job.id, status: "RUNNING", lockedAt: { lt: staleLockCutoff } },
      data: {
        status: exhausted ? "FAILED" : "QUEUED",
        runAt: exhausted ? undefined : new Date(), // immediate eligibility on retry
        lockedAt: null,
        lockedBy: null,
        lastError: exhausted
          ? `Stale lock recovered after max attempts (${job.attempts}/${job.maxAttempts}) — dead-lettered`
          : "Stale lock recovered — previous worker died or timed out",
      },
    });
    if (res.count === 1) {
      if (exhausted) deadLettered += 1;
      else requeued += 1;
    }
  }
  if (requeued + deadLettered > 0) {
    logger.warn("queue.stale_recovered", { requeued, deadLettered });
  }
  return { requeued, deadLettered };
}

/** Coarse queue health for /api/health (counts only). */
export async function queueDepth(): Promise<{ queued: number; running: number; failed: number }> {
  const [queued, running, failed] = await Promise.all([
    db.backgroundJob.count({ where: { status: "QUEUED" } }),
    db.backgroundJob.count({ where: { status: "RUNNING" } }),
    db.backgroundJob.count({ where: { status: "FAILED" } }),
  ]);
  return { queued, running, failed };
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

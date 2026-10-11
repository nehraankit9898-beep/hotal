/**
 * Phase 7 — standalone background worker (spec §15, §19, §28).
 *
 * Usage: bun run scripts/worker.ts   (or: npm/bun run worker)
 *
 * Responsibilities:
 * - Validate production configuration BEFORE consuming a single job (fail
 *   closed — same rules as the web server: AUTH_SECRET, encryption key,
 *   PostgreSQL DATABASE_URL, no placeholder values).
 * - Claim and execute queued jobs (campaign sends, CSV exports) with
 *   optimistic locking + LEASE FENCING so multiple workers run side by side
 *   and a stale worker can never overwrite a newer claim.
 * - Renew the lease of long-running jobs (heartbeat) so the 10-minute
 *   staleness TTL does not reclaim healthy work.
 * - Requeue failed jobs with exponential backoff; dead-letter after max tries
 *   (also enforced by recoverStaleJobs for exhausted jobs).
 * - Recover stale locks from crashed/timed-out workers.
 * - Process PENDING backup records (manual triggers + scheduled backups).
 * - Purge expired security tokens, audit retention and old export files.
 * - Write an observable heartbeat (DB + local file) used by health checks.
 * - Graceful SIGTERM/SIGINT shutdown (finishes the current job, then exits).
 *
 * Production: run ONE OR MORE of these alongside the web process — see
 * docker-compose.prod.yml (worker service) and docs/DEPLOYMENT.md.
 */

import { randomUUID } from "crypto";
import { db } from "../src/lib/db";
import { logger } from "../src/lib/logger";
import {
  claimNextJob,
  completeJob,
  failJob,
  deadLetterJob,
  recoverStaleJobs,
  renewLease,
  JOB_HEARTBEAT_MS,
  type ClaimedJob,
} from "../src/lib/queue";
import { runJob, cleanupExpiredExports } from "../src/lib/jobs/handlers";
import { purgeExpiredTokens } from "../src/lib/security-tokens";
import { purgeOldAuthAttempts } from "../src/lib/login-security";
// Phase 10 — SaaS lifecycle maintenance
import { processTrialExpiry, processRenewals } from "../src/lib/saas/subscriptions";
import { processScheduledGlobalFlags } from "../src/lib/saas/entitlements";
import {
  enforceRetention,
  runBackup,
  recoverStaleBackups,
  processPendingBackups,
  claimScheduledBackup,
} from "../src/lib/saas/backup";
import { getSetting } from "../src/lib/saas/settings";
import { logAudit, AUDIT_ACTIONS } from "../src/lib/audit";
import { setWorkerHeartbeat, writeLocalHeartbeat } from "../src/lib/worker-heartbeat";
// Phase 11 — durable scheduler (due campaigns, automation triggers, journeys)
import { runSchedulerSweep } from "../src/lib/scheduler";

const workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
const IDLE_POLL_MS = 2000;
const HOUSEKEEPING_EVERY_MS = 10 * 60 * 1000;
const STALE_RECOVERY_EVERY_MS = 60 * 1000;
const WORKER_HEARTBEAT_MS = 30 * 1000;
const PENDING_BACKUP_POLL_MS = 5 * 1000;
// Phase 11 — scheduler cadence. Campaigns/journeys sweep frequently (fast
// dispatch + catch-up); the automation trigger scan is heavier (per-hotel
// queries) so it runs on a slower cadence, matching its day-granularity
// triggers. Both are idempotent — cadence affects latency, never correctness.
const SCHEDULER_EVERY_MS = 60 * 1000;
const AUTOMATION_SCAN_EVERY_MS = 15 * 60 * 1000;
// Phase 15 — owner report sweep cadence (initial; overwritten by the module).
let REPORT_SWEEP_EVERY_MS = 10 * 60 * 1000;

let shuttingDown = false;
let currentJob: ClaimedJob | null = null;
let leaseLost = false; // current job lost its lease — complete/fail will be fenced
let jobsCompleted = 0;

/* ------------------------------------------------------------------ */
/* Startup configuration validation (audit fix 4F)                     */
/* ------------------------------------------------------------------ */

/**
 * Validate the production environment BEFORE consuming jobs. The web server
 * does this in instrumentation.ts; the standalone worker must not silently
 * run misconfigured (e.g. SQLite dev URL, missing AUTH_SECRET).
 */
async function validateWorkerConfig(): Promise<void> {
  const { isProduction, validateStartupConfig } = await import("../src/lib/config");
  const { validateExtendedEnv } = await import("../src/lib/env");

  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    console.error("[worker] DATABASE_URL is not set — refusing to start.");
    process.exit(1);
  }
  if (isProduction() && databaseUrl.startsWith("file:")) {
    console.error(
      "[worker] Invalid production configuration: DATABASE_URL points to SQLite (file:). " +
        "Set DATABASE_URL to a PostgreSQL connection string (see prisma/schema.postgres.prisma).",
    );
    process.exit(1);
  }

  const core = validateStartupConfig();
  const extended = validateExtendedEnv();
  const errors = [...core.errors, ...extended.errors];
  if (errors.length > 0) {
    console.error(
      "RestroLoop worker configuration is invalid:\n" + errors.map((e) => `  - ${e}`).join("\n"),
    );
    process.exit(1);
  }
  // A live database is required to consume jobs — fail fast, not after the
  // first claim attempt.
  try {
    await db.$queryRaw`SELECT 1`;
  } catch (err) {
    console.error(
      "[worker] Cannot reach the database: " +
        (err instanceof Error ? err.message.slice(0, 200) : String(err)),
    );
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/* Heartbeats                                                           */
/* ------------------------------------------------------------------ */

async function beat(): Promise<void> {
  const value = { workerId, at: Date.now(), pid: process.pid, jobsCompleted };
  writeLocalHeartbeat(value);
  await setWorkerHeartbeat(value);
}

/** Renew the current job's lease; mark `leaseLost` when another owner took over. */
async function renewCurrentJobLease(): Promise<void> {
  if (!currentJob || leaseLost) return;
  try {
    const ok = await renewLease(currentJob.id, currentJob.leaseId);
    if (!ok && !shuttingDown) {
      // Our lease was reclaimed (or the job was completed/dead-lettered
      // elsewhere). Keep running the handler for its side effects, but all
      // completion writes are fenced — we can no longer overwrite the new state.
      leaseLost = true;
      logger.error("worker.lease_lost", { jobId: currentJob.id, workerId });
    }
  } catch (err) {
    // Medium fix: a transient DB error inside the heartbeat timer previously
    // produced an unhandled rejection that could kill the whole worker
    // fleet mid-job. The lease simply renews on the next tick; a genuinely
    // lost lease is caught by the 10-minute staleness recovery.
    logger.warn("worker.lease_renew_error", {
      jobId: currentJob.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Job processing                                                       */
/* ------------------------------------------------------------------ */

async function processNextJob(): Promise<boolean> {
  const job = await claimNextJob(workerId);
  if (!job) return false;

  currentJob = job;
  leaseLost = false;
  const startedAt = Date.now();
  logger.info("worker.job_started", {
    jobId: job.id,
    type: job.type,
    attempt: job.attempts,
    lease: job.leaseId,
  });
  try {
    const outcome = await runJob({
      jobId: job.id,
      type: job.type,
      payload: job.payload,
      hotelId: job.hotelId,
      createdBy: job.createdBy,
    });

    if (leaseLost) {
      // A newer owner owns this job — do NOT write our (stale) result.
      logger.warn("worker.job_result_discarded_stale_lease", { jobId: job.id });
    } else if (outcome.ok) {
      const won = await completeJob(job.id, outcome.result ?? {}, job.leaseId);
      if (won) {
        jobsCompleted += 1;
        logger.info("worker.job_done", {
          jobId: job.id,
          type: job.type,
          ms: Date.now() - startedAt,
        });
      }
    } else if (outcome.permanent) {
      // Skip retries for validation errors — straight to dead-letter.
      await deadLetterJob(
        job.id,
        String(outcome.result?.error ?? "Permanent failure"),
        job.leaseId,
      );
    } else {
      await failJob(job.id, String(outcome.result?.error ?? "Job failed"), job.leaseId);
    }
  } catch (err) {
    if (!leaseLost) {
      await failJob(job.id, err, job.leaseId);
    } else {
      logger.warn("worker.job_error_discarded_stale_lease", { jobId: job.id });
    }
  } finally {
    currentJob = null;
    leaseLost = false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Scheduled + pending backups (audit fix 3)                            */
/* ------------------------------------------------------------------ */

/**
 * Phase 10 §16 — run a backup when the schedule says it is due.
 *
 * AUDIT FIX (backup-1): the schedule decision now lives in
 * claimScheduledBackup (DB-level CAS on a PlatformSetting row + the PENDING
 * record created in the SAME transaction). Previously every worker ran its
 * own read-then-create here, so N workers produced N backups per due period,
 * and one FAILED scheduled backup stalled the schedule forever. The claim
 * fences retries for 15 minutes on failure and until the next real due time
 * on success; the pending sweep below (any worker) executes the record.
 */
async function runScheduledBackup(): Promise<void> {
  const claimed = await claimScheduledBackup();
  if (!claimed) return;
  const result = await runBackup({ recordId: claimed.recordId, reason: "scheduled" });
  logger.info("worker.backup", {
    status: result.status,
    file: result.filename,
    error: result.error,
  });
  await enforceRetention();
}

/**
 * A backup reported as QUEUED (PENDING record) must actually be processed:
 * the worker picks pending records up within seconds of the manual trigger.
 */
async function sweepPendingBackups(): Promise<void> {
  const processed = await processPendingBackups();
  if (processed > 0) {
    logger.info("worker.backup_pending_processed", { processed });
  }
}

/** Phase 10 privacy — retention purge for audit logs + security events. */
async function purgeExpiredSecurityEvents(): Promise<void> {
  const privacy = await getSetting("privacy");
  const months = Math.max(1, privacy.securityEventRetentionMonths);
  const cutoff = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000);
  const purged = await db.securityEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (purged.count > 0) {
    await logAudit({
      action: "SECURITY_RETENTION_PURGE",
      entityType: "security_event",
      metadata: { purged: purged.count, months },
    });
  }
  const auditMonths = Math.max(1, privacy.auditRetentionMonths);
  const auditCutoff = new Date(Date.now() - auditMonths * 30 * 24 * 60 * 60 * 1000);
  const auditPurged = await db.auditLog.deleteMany({ where: { createdAt: { lt: auditCutoff } } });
  if (auditPurged.count > 0) {
    await logAudit({
      action: "AUDIT_RETENTION_PURGE",
      entityType: "audit_log",
      metadata: { purged: auditPurged.count, months: auditMonths },
    });
  }
}

async function main(): Promise<never> {
  await validateWorkerConfig();
  logger.info("worker.started", { workerId, pid: process.pid });
  await beat();

  // Independent heartbeat timers — they keep beating while a long job runs
  // (the main loop is blocked inside runJob, not inside these callbacks).
  const beatTimer = setInterval(() => {
    void beat();
  }, WORKER_HEARTBEAT_MS);
  const leaseTimer = setInterval(() => {
    void renewCurrentJobLease();
  }, JOB_HEARTBEAT_MS);
  beatTimer.unref?.();
  leaseTimer.unref?.();

  let lastHousekeeping = 0;
  let lastRecovery = 0;
  let lastSaasSweep = 0;
  let lastBackupSweep = 0;
  let lastPendingBackupSweep = 0;
  let lastSchedulerSweep = 0;
  let lastAutomationScan = 0;
  let lastReportSweep = 0;
  // Phase 17 — outbound webhook delivery sweep cadence.
  let lastWebhookSweep = 0;
  const WEBHOOK_SWEEP_EVERY_MS = 30 * 1000;
  const SAAS_SWEEP_EVERY_MS = 5 * 60 * 1000; // trial expiry / renewals / flags
  const BACKUP_SWEEP_EVERY_MS = 60 * 60 * 1000; // scheduled backups + retention

  // Main loop.
  for (;;) {
    if (shuttingDown) break;

    const now = Date.now();
    try {
      if (now - lastRecovery > STALE_RECOVERY_EVERY_MS) {
        await recoverStaleJobs();
        lastRecovery = now;
      }
      if (now - lastHousekeeping > HOUSEKEEPING_EVERY_MS) {
        await purgeExpiredTokens().catch(() => 0);
        // Login-attempt rows older than the throttle window are never read again.
        await purgeOldAuthAttempts().catch(() => 0);
        cleanupExpiredExports(24);
        lastHousekeeping = now;
      }
      // Phase 10 §4/§5 — trial expiry (TRIAL → GRACE → EXPIRED), renewals and
      // scheduled global feature flags.
      if (now - lastSaasSweep > SAAS_SWEEP_EVERY_MS) {
        const trials = await processTrialExpiry().catch((err) => {
          logger.error("worker.trial_sweep_failed", { error: String(err) });
          return { toGrace: 0, toExpired: 0, graceExpired: 0 };
        });
        if (trials.toGrace + trials.toExpired + trials.graceExpired > 0) {
          logger.info("worker.trial_sweep", trials);
        }
        await processRenewals().catch((err) => {
          logger.error("worker.renewal_sweep_failed", { error: String(err) });
        });
        await processScheduledGlobalFlags().catch((err) => {
          logger.error("worker.flag_sweep_failed", { error: String(err) });
        });
        await purgeExpiredSecurityEvents().catch((err) => {
          logger.error("worker.security_retention_failed", { error: String(err) });
        });
        // Recover stuck RUNNING backup records (crashed worker).
        await recoverStaleBackups().catch((err) => {
          logger.error("worker.backup_recovery_failed", { error: String(err) });
        });
        lastSaasSweep = now;
      }
      // Phase 10 §16 — scheduled encrypted backups + retention enforcement.
      if (now - lastBackupSweep > BACKUP_SWEEP_EVERY_MS) {
        await runScheduledBackup().catch((err) => {
          logger.error("worker.backup_sweep_failed", { error: String(err) });
        });
        lastBackupSweep = now;
      }
      // Manual triggers: PENDING backup records are processed within seconds.
      if (now - lastPendingBackupSweep > PENDING_BACKUP_POLL_MS) {
        await sweepPendingBackups();
        lastPendingBackupSweep = now;
      }

      // Phase 11 — durable scheduler: due SCHEDULED campaigns are claimed +
      // enqueued exactly once; due journey steps are delivered exactly once.
      // Both sweeps are idempotent, so multiple workers running this loop
      // never double-dispatch (DB-level claims + unique constraints).
      if (now - lastSchedulerSweep > SCHEDULER_EVERY_MS) {
        const sweep = await runSchedulerSweep(new Date(now)).catch((err) => {
          logger.error("worker.scheduler_sweep_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
        if (sweep && sweep.campaignsDispatched + sweep.journeyDeliveriesSent + sweep.journeyDeliveriesSkipped + sweep.journeyDeliveriesFailed + sweep.journeyEnrollmentsCompleted > 0) {
          logger.info("worker.scheduler_sweep", sweep);
        }
        lastSchedulerSweep = now;
      }
      // Phase 11 — automation trigger scan on a slower cadence (day-granularity
      // triggers; the scan is per-hotel and heavier). The scheduler sweep above
      // already drains PENDING executions every minute; this runs the SCAN that
      // queues new executions from trigger conditions (birthdays, checkouts…).
      if (now - lastAutomationScan > AUTOMATION_SCAN_EVERY_MS) {
        const { sweepAutomationTriggers } = await import("../src/lib/scheduler");
        await sweepAutomationTriggers(new Date(now), { runPending: false }).catch((err) => {
          logger.error("worker.automation_scan_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        lastAutomationScan = now;
      }

      // Phase 15 — owner report schedules: enqueue OWNER_REPORT jobs for due
      // schedules (tenant-local hour match + occurrence fence). Safe with N
      // workers (conditional claim on lastSentAt).
      if (now - lastReportSweep > REPORT_SWEEP_EVERY_MS) {
        const { sweepOwnerReports, OWNER_REPORT_SWEEP_INTERVAL_MS } = await import("../src/lib/report-sweep");
        REPORT_SWEEP_EVERY_MS = OWNER_REPORT_SWEEP_INTERVAL_MS;
        const enqueued = await sweepOwnerReports(new Date(now)).catch((err) => {
          logger.error("worker.report_sweep_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          return -1;
        });
        if (enqueued > 0) logger.info("worker.report_sweep", { enqueued });
        lastReportSweep = now;
      }

      // Phase 17 — outbound webhook delivery sweep. Drains PENDING and
      // due FAILED deliveries with atomic claim fencing (multi-worker safe).
      if (now - lastWebhookSweep > WEBHOOK_SWEEP_EVERY_MS) {
        const { sweepDueWebhookDeliveries } = await import("../src/lib/webhooks-out");
        const delivered = await sweepDueWebhookDeliveries(50).catch((err) => {
          logger.error("worker.webhook_sweep_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          return 0;
        });
        if (delivered > 0) logger.info("worker.webhook_sweep", { delivered });
        lastWebhookSweep = now;
      }

      const worked = await processNextJob();
      if (!worked) {
        await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
      }
    } catch (err) {
      logger.error("worker.loop_error", {
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  clearInterval(beatTimer);
  clearInterval(leaseTimer);
  logger.info("worker.stopped", { workerId, jobsCompleted });
  await db.$disconnect().catch(() => undefined);
  process.exit(0);
}

// Bun's type definitions narrow process.on; cast to the Node signature so
// the worker handles the standard termination signals in production too.
const proc = process as unknown as {
  on(signal: string, listener: () => void): void;
};
proc.on("SIGTERM", () => {
  logger.info("worker.sigterm", { workerId, currentJob: currentJob?.id ?? null });
  shuttingDown = true;
});
proc.on("SIGINT", () => {
  shuttingDown = true;
});

main().catch((err) => {
  logger.error("worker.fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

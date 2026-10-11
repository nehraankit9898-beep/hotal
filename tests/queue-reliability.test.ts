/**
 * Queue reliability — regression tests for the Phase 10 audit fixes:
 *
 *  A. recoverStaleJobs dead-letters exhausted jobs (it used to requeue them
 *     forever with unbounded attempts).
 *  B. Lease heartbeat renewal keeps long jobs from being reclaimed.
 *  C. Lease FENCING: a stale worker cannot complete/fail a job that a newer
 *     worker claimed (its writes are rejected).
 *  D. Two workers claiming: exactly one wins; the loser tries the next job.
 *
 * These tests run against a throwaway SQLite database (STAYLOOP_TEST=1) and
 * exercise src/lib/queue.ts directly (no HTTP).
 */
import "./queue-test-env";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { QUEUE_TEST_TMP, cleanupQueueTestTmp } from "./queue-test-env";

const db = new PrismaClient({
  datasources: { db: { url: `${process.env.DATABASE_URL}?connection_limit=1` } },
});

import {
  enqueueJob,
  claimNextJob,
  completeJob,
  failJob,
  deadLetterJob,
  renewLease,
  recoverStaleJobs,
} from "../src/lib/queue";

beforeAll(async () => {
  // Minimal schema for BackgroundJob only (SQLite test DB).
  await db.$executeRawUnsafe(`
    CREATE TABLE "BackgroundJob" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "hotelId" TEXT,
      "type" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'QUEUED',
      "payload" TEXT NOT NULL,
      "result" TEXT,
      "attempts" INTEGER NOT NULL DEFAULT 0,
      "maxAttempts" INTEGER NOT NULL DEFAULT 3,
      "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "lockedAt" DATETIME,
      "lockedBy" TEXT,
      "lastError" TEXT,
      "createdBy" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )
  `);
});

afterAll(async () => {
  await db.$disconnect();
  cleanupQueueTestTmp();
});
void QUEUE_TEST_TMP;

function backdate(id: string, minutes: number): Promise<unknown> {
  return db.backgroundJob.update({
    where: { id },
    data: { lockedAt: new Date(Date.now() - minutes * 60 * 1000) },
  });
}

describe("queue claim + lease fencing", () => {
  test("exactly one of two concurrent claimers wins a job", async () => {
    const id = await enqueueJob("CSV_EXPORT", { hotelId: null });
    const [a, b] = await Promise.all([claimNextJob("w1"), claimNextJob("w2")]);
    const claimed = [a, b].filter((c) => c !== null);
    expect(claimed.length).toBe(1);
    expect(claimed[0]!.id).toBe(id);
    expect(claimed[0]!.attempts).toBe(1);
    // The claim carries a lease id unique to this claim.
    expect(claimed[0]!.leaseId).toContain("w");
  });

  test("completeJob is fenced on the lease (stale worker rejected)", async () => {
    const id = await enqueueJob("CSV_EXPORT", { hotelId: null });
    const first = (await claimNextJob("w1"))!;
    // Simulate: the job's lease is lost/reclaimed by another worker before
    // the first worker finishes (worker 2 re-claims after stale recovery).
    await backdate(id, 15);
    await recoverStaleJobs();
    const second = (await claimNextJob("w2"))!;

    // STALE worker tries to complete with its OLD lease → rejected.
    const staleComplete = await completeJob(id, { rows: 1 }, first.leaseId);
    expect(staleComplete).toBe(false);

    // The NEW owner completes successfully.
    const freshComplete = await completeJob(id, { rows: 1 }, second.leaseId);
    expect(freshComplete).toBe(true);
    const job = await db.backgroundJob.findUnique({ where: { id } });
    expect(job?.status).toBe("COMPLETED");
    expect(job?.result).toContain("rows");
  });

  test("failJob is fenced — a stale worker cannot fail a newer claim", async () => {
    const id = await enqueueJob("CSV_EXPORT", { hotelId: null });
    const first = (await claimNextJob("w1"))!;
    await backdate(id, 15);
    await recoverStaleJobs();
    const second = (await claimNextJob("w2"))!;

    const staleFail = await failJob(id, new Error("stale worker failure"), first.leaseId);
    expect(staleFail).toBe("lease_lost");
    // Job remains RUNNING under the new lease.
    const mid = await db.backgroundJob.findUnique({ where: { id } });
    expect(mid?.status).toBe("RUNNING");
    expect(mid?.lockedBy).toBe(second.leaseId);

    const freshFail = await failJob(id, new Error("real failure"), second.leaseId);
    expect(["retried", "dead_letter"]).toContain(freshFail);
    const after = await db.backgroundJob.findUnique({ where: { id } });
    expect(after?.status).toBe("QUEUED"); // attempts 1 < 3 → retry scheduled
    expect(after?.lastError).toContain("real failure");
  });

  test("deadLetterJob is fenced too", async () => {
    const id = await enqueueJob("CSV_EXPORT", { hotelId: null });
    const first = (await claimNextJob("w1"))!;
    const stale = await deadLetterJob(id, "permanent", "someone-elses-lease");
    expect(stale).toBe(false);
    const fresh = await deadLetterJob(id, "permanent validation error", first.leaseId);
    expect(fresh).toBe(true);
    const job = await db.backgroundJob.findUnique({ where: { id } });
    expect(job?.status).toBe("FAILED");
    expect(job?.lastError).toContain("permanent validation error");
  });
});

describe("lease heartbeat renewal", () => {
  test("renewLease extends lockedAt and reports lost leases", async () => {
    const id = await enqueueJob("CSV_EXPORT", { hotelId: null });
    const job = (await claimNextJob("w1"))!;
    const before = await db.backgroundJob.findUnique({ where: { id } });
    await new Promise((r) => setTimeout(r, 30));
    const ok = await renewLease(id, job.leaseId);
    expect(ok).toBe(true);
    const after = await db.backgroundJob.findUnique({ where: { id } });
    expect(after!.lockedAt!.getTime()).toBeGreaterThanOrEqual(before!.lockedAt!.getTime());
    // Wrong lease → lost.
    const lost = await renewLease(id, "wX#not-the-lease");
    expect(lost).toBe(false);
  });

  test("a heartbeat-renewed job is NOT recovered as stale", async () => {
    const id = await enqueueJob("CSV_EXPORT", { hotelId: null });
    const job = (await claimNextJob("w1"))!;
    // Job has been running "long" but the lease was renewed.
    await db.backgroundJob.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - 20 * 60 * 1000), lockedAt: new Date() },
    });
    const res = await recoverStaleJobs();
    expect(res.requeued).toBe(0);
    expect(res.deadLettered).toBe(0);
    const still = await db.backgroundJob.findUnique({ where: { id } });
    expect(still?.status).toBe("RUNNING");
    expect(still?.lockedBy).toBe(job.leaseId);
  });
});

describe("stale recovery + dead-letter (audit fix A)", () => {
  test("exhausted attempts are dead-lettered, not requeued forever", async () => {
    // attempts already == maxAttempts (3 attempts made on previous crashes)
    const id = await enqueueJob("CSV_EXPORT", {}, { maxAttempts: 3 });
    await db.backgroundJob.update({
      where: { id },
      data: {
        attempts: 3,
        status: "RUNNING",
        lockedAt: new Date(Date.now() - 20 * 60 * 1000),
        lockedBy: "w1#dead",
      },
    });
    const res = await recoverStaleJobs();
    expect(res.deadLettered).toBe(1);
    expect(res.requeued).toBe(0);
    const job = await db.backgroundJob.findUnique({ where: { id } });
    expect(job?.status).toBe("FAILED");
    expect(job?.lastError).toContain("dead-lettered");
    // Attempts never exceed maxAttempts — the retry budget is bounded.
    expect(job?.attempts).toBe(3);
  });

  test("remaining attempts are requeued with the counter preserved", async () => {
    const id = await enqueueJob("CSV_EXPORT", {}, { maxAttempts: 3 });
    await db.backgroundJob.update({
      where: { id },
      data: {
        attempts: 1,
        status: "RUNNING",
        lockedAt: new Date(Date.now() - 20 * 60 * 1000),
        lockedBy: "w1#dead",
      },
    });
    const res = await recoverStaleJobs();
    expect(res.requeued).toBe(1);
    expect(res.deadLettered).toBe(0);
    const job = await db.backgroundJob.findUnique({ where: { id } });
    expect(job?.status).toBe("QUEUED");
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toContain("Stale lock recovered");
    // The requeued job is immediately claimable again.
    const requeued = await claimNextJob("w2");
    expect(requeued?.id).toBe(id);
    expect(requeued?.attempts).toBe(2);
  });

  test("failJob retries with backoff then dead-letters after max attempts", async () => {
    const id = await enqueueJob("CSV_EXPORT", {}, { maxAttempts: 2 });
    // Attempt 1
    let job = (await claimNextJob("w1"))!;
    expect(await failJob(id, new Error("boom"), job.leaseId)).toBe("retried");
    let row = await db.backgroundJob.findUnique({ where: { id } });
    expect(row?.status).toBe("QUEUED");
    expect(row?.runAt.getTime()).toBeGreaterThan(Date.now()); // backoff scheduled
    // Attempt 2 (final) — backoff scheduled the retry in the future; fast-forward.
    await db.backgroundJob.update({ where: { id }, data: { runAt: new Date(Date.now() - 1000) } });
    job = (await claimNextJob("w1"))!;
    expect(job.attempts).toBe(2);
    expect(await failJob(id, new Error("boom again"), job.leaseId)).toBe("dead_letter");
    row = await db.backgroundJob.findUnique({ where: { id } });
    expect(row?.status).toBe("FAILED");
    expect(row?.attempts).toBe(2);
  });
});

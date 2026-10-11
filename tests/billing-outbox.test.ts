/**
 * Payment confirmation consistency — regression tests for the billing audit
 * fixes:
 *
 *  billing-1 (transactional flip + outbox): markPaymentPaid flips PENDING→PAID
 *    and enqueues a PAYMENT_CONFIRMED job in ONE transaction. A crash between
 *    the flip and the follow-up is recoverable (worker job + alreadyPaid path
 *    both re-run the idempotent follow-up).
 *  billing-2 (idempotent follow-up): processPaymentConfirmation redeems the
 *    coupon EXACTLY ONCE per payment and activates EXACTLY ONE subscription
 *    (Payment.subscriptionId link claim) — no matter how many times it runs.
 *  billing-3 (refund race): concurrent refunds cannot over-refund past the
 *    payment amount (optimistic-concurrency guard).
 *
 * Uses a throwaway SQLite database with the FULL schema pushed via
 * `prisma db push` (same generator the test harness uses).
 */
import "./queue-test-env";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { resolve } from "path";
import { PrismaClient } from "@prisma/client";
import { cleanupQueueTestTmp } from "./queue-test-env";

const ROOT = resolve(import.meta.dir, "..");
const db = new PrismaClient({
  datasources: { db: { url: `${process.env.DATABASE_URL}?connection_limit=1` } },
});

import {
  markPaymentPaid,
  processPaymentConfirmation,
  refundPayment,
  PAYMENT_CONFIRMED_JOB,
} from "../src/lib/saas/billing";
import { runJob } from "../src/lib/jobs/handlers";

beforeAll(async () => {
  const push = spawnSync(
    "bunx",
    [
      "prisma",
      "db",
      "push",
      "--schema",
      "prisma/schema.prisma",
      "--skip-generate",
      "--accept-data-loss",
    ],
    { cwd: ROOT, env: process.env, stdio: "pipe", timeout: 120_000 },
  );
  if (push.status !== 0) {
    throw new Error(
      "prisma db push failed:\n" +
        (String(push.stdout ?? "") + String(push.stderr ?? "")).slice(0, 2000),
    );
  }
}, 180_000);

afterAll(async () => {
  await db.$disconnect();
  cleanupQueueTestTmp();
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

async function fixture(opts: { withCoupon?: boolean; couponUsageLimit?: number } = {}) {
  const plan = await db.plan.create({
    data: {
      name: `PLAN-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      key: `plan-${Math.random().toString(36).slice(2, 10)}`,
      monthlyPrice: 1999,
      yearlyPrice: 19990,
      currency: "INR",
    },
  });
  const hotel = await db.hotel.create({
    data: { name: "Outbox Test Hotel", planId: plan.id, tenantId: `T-${Date.now()}` },
  });
  // A REAL user row — audit logs have FKs on userId (fake ids would violate
  // them; logAudit swallows the error but the audit trail would be lost).
  const admin = await db.user.create({
    data: {
      name: "Outbox Admin",
      email: `outbox-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
      passwordHash: "x".repeat(60),
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    },
  });
  const adminUserId = admin.id;
  let couponId: string | null = null;
  if (opts.withCoupon) {
    const coupon = await db.billingCoupon.create({
      data: {
        code: `OUTBOX${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        discountType: "PERCENT",
        percentOff: 10,
        isActive: true,
        ...(opts.couponUsageLimit !== undefined ? { usageLimit: opts.couponUsageLimit } : {}),
      },
    });
    couponId = coupon.id;
  }
  const payment = await db.payment.create({
    data: {
      hotelId: hotel.id,
      planId: plan.id,
      invoiceNumber: `SL-TEST-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      description: "test payment",
      amount: 1799,
      currency: "INR",
      status: "PENDING",
      provider: "manual",
      billingCycle: "MONTHLY",
      couponId,
      couponCode: couponId ? "OUTBOX" : null,
      idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    },
  });
  return { plan, hotel, payment, couponId, adminUserId };
}

/* ------------------------------------------------------------------ */
/* billing-1: atomic flip + outbox                                     */
/* ------------------------------------------------------------------ */

describe("billing-1 — status flip and outbox job are atomic", () => {
  test("markPaymentPaid creates the PAYMENT_CONFIRMED outbox job (same commit as the flip)", async () => {
    const { payment } = await fixture();
    const result = await markPaymentPaid({
      paymentId: payment.id,
      provider: "manual",
      reason: "test-confirm",
    });
    expect(result.ok).toBe(true);

    const paid = await db.payment.findUnique({ where: { id: payment.id } });
    expect(paid?.status).toBe("PAID");
    expect(paid?.paidAt).not.toBeNull();

    const jobs = await db.backgroundJob.findMany({
      where: { type: PAYMENT_CONFIRMED_JOB, payload: { contains: payment.id } },
    });
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.status).toBe("QUEUED");
    expect(jobs[0]?.maxAttempts).toBeGreaterThanOrEqual(3);
  });

  test("duplicate confirm does NOT create a second outbox job", async () => {
    const { payment } = await fixture();
    await markPaymentPaid({ paymentId: payment.id, reason: "first" });
    const again = await markPaymentPaid({ paymentId: payment.id, reason: "replay" });
    expect(again.ok).toBe(true);
    expect(again.alreadyPaid).toBe(true);

    const jobs = await db.backgroundJob.findMany({
      where: { type: PAYMENT_CONFIRMED_JOB, payload: { contains: payment.id } },
    });
    expect(jobs.length).toBe(1);
  });

  test("the outbox job is a no-op double-check when the inline follow-up ran (worker path)", async () => {
    const { payment } = await fixture({ withCoupon: true });
    await markPaymentPaid({ paymentId: payment.id, reason: "inline" });
    // Subscription already active + coupon redeemed inline.
    const before = await db.payment.findUnique({ where: { id: payment.id } });
    expect(before?.subscriptionId).not.toBeNull();

    const job = await db.backgroundJob.findFirst({
      where: { type: PAYMENT_CONFIRMED_JOB, payload: { contains: payment.id } },
    });
    expect(job).not.toBeNull();

    const outcome = await runJob({
      jobId: job!.id,
      type: job!.type,
      payload: JSON.parse(job!.payload),
      hotelId: job!.hotelId,
      createdBy: job!.createdBy,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.alreadyComplete).toBe(true);

    // Still exactly one ACTIVE subscription for the hotel.
    const active = await db.subscription.findMany({
      where: { hotelId: before!.hotelId, status: "ACTIVE" },
    });
    expect(active.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* billing-1 (crash recovery): flip without follow-up                  */
/* ------------------------------------------------------------------ */

describe("billing-1 — crash between flip and follow-up is recoverable", () => {
  test("alreadyPaid path completes a follow-up that never ran", async () => {
    const { payment, couponId, hotel } = await fixture({ withCoupon: true });

    // Simulate the crash: flip the status + create the outbox row WITHOUT
    // running the inline follow-up (exactly the committed state a crash
    // between the transaction and the follow-up would leave behind).
    await db.$transaction(async (tx) => {
      await tx.payment.updateMany({
        where: { id: payment.id, status: "PENDING" },
        data: { status: "PAID", paidAt: new Date() },
      });
      await tx.backgroundJob.create({
        data: {
          type: PAYMENT_CONFIRMED_JOB,
          payload: JSON.stringify({ paymentId: payment.id, reason: "crash-simulation" }),
          hotelId: hotel.id,
          maxAttempts: 5,
        },
      });
    });

    // No subscription, no redemption yet.
    expect((await db.payment.findUnique({ where: { id: payment.id } }))?.subscriptionId).toBeNull();

    // A duplicate webhook (or the worker's outbox run) recovers it.
    const replay = await markPaymentPaid({
      paymentId: payment.id,
      reason: "webhook replay after crash",
    });
    expect(replay.ok).toBe(true);
    expect(replay.alreadyPaid).toBe(true);

    const after = await db.payment.findUnique({ where: { id: payment.id } });
    expect(after?.subscriptionId).not.toBeNull();
    const coupon = await db.billingCoupon.findUnique({ where: { id: couponId! } });
    expect(coupon?.usedCount).toBe(1);
  });

  test("the worker's outbox handler alone completes a crashed confirmation", async () => {
    const { payment, couponId, hotel } = await fixture({ withCoupon: true });
    await db.$transaction(async (tx) => {
      await tx.payment.updateMany({
        where: { id: payment.id, status: "PENDING" },
        data: { status: "PAID", paidAt: new Date() },
      });
      await tx.backgroundJob.create({
        data: {
          type: PAYMENT_CONFIRMED_JOB,
          payload: JSON.stringify({ paymentId: payment.id, reason: "crash-simulation-2" }),
          hotelId: hotel.id,
          maxAttempts: 5,
        },
      });
    });

    const job = await db.backgroundJob.findFirst({
      where: { type: PAYMENT_CONFIRMED_JOB, payload: { contains: payment.id } },
    });
    const outcome = await runJob({
      jobId: job!.id,
      type: job!.type,
      payload: JSON.parse(job!.payload),
      hotelId: job!.hotelId,
      createdBy: job!.createdBy,
    });
    expect(outcome.ok).toBe(true);

    const after = await db.payment.findUnique({ where: { id: payment.id } });
    expect(after?.subscriptionId).not.toBeNull();
    const coupon = await db.billingCoupon.findUnique({ where: { id: couponId! } });
    expect(coupon?.usedCount).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* billing-2: idempotent follow-up                                     */
/* ------------------------------------------------------------------ */

describe("billing-2 — coupon redemption and subscription activation are exactly-once", () => {
  test("running processPaymentConfirmation 3x redeems the coupon exactly once", async () => {
    const { payment, couponId } = await fixture({ withCoupon: true });
    await db.payment.updateMany({
      where: { id: payment.id },
      data: { status: "PAID", paidAt: new Date() },
    });

    for (let i = 0; i < 3; i++) {
      const r = await processPaymentConfirmation({ paymentId: payment.id });
      expect(r.ok).toBe(true);
      if (i > 0) expect(r.alreadyComplete).toBe(true);
    }

    const coupon = await db.billingCoupon.findUnique({ where: { id: couponId! } });
    expect(coupon?.usedCount).toBe(1);
    const paid = await db.payment.findUnique({ where: { id: payment.id } });
    expect(paid?.metadata).toContain("couponRedeemedAt");
  });

  test("concurrent follow-up runs produce exactly ONE active subscription and ONE redemption", async () => {
    const { payment, couponId, hotel } = await fixture({ withCoupon: true });
    await db.payment.updateMany({
      where: { id: payment.id },
      data: { status: "PAID", paidAt: new Date() },
    });

    // Fire three concurrent runs — on SQLite writes serialize, but the claim
    // guards are what make this correct on PostgreSQL too.
    const results = await Promise.allSettled([
      processPaymentConfirmation({ paymentId: payment.id }),
      processPaymentConfirmation({ paymentId: payment.id }),
      processPaymentConfirmation({ paymentId: payment.id }),
    ]);
    // At least one succeeded; losers either saw alreadyComplete or lost a
    // claim (rejected) — never a duplicate effect.
    expect(results.some((r) => r.status === "fulfilled" && r.value.ok)).toBe(true);

    const active = await db.subscription.findMany({
      where: { hotelId: hotel.id, status: "ACTIVE" },
    });
    expect(active.length).toBe(1);
    const coupon = await db.billingCoupon.findUnique({ where: { id: couponId! } });
    expect(coupon?.usedCount).toBe(1);
    const paid = await db.payment.findUnique({ where: { id: payment.id } });
    expect(paid?.subscriptionId).toBe(active[0]?.id);
  });

  test("coupon at its usage limit does not block the subscription activation", async () => {
    const { payment } = await fixture({ withCoupon: true, couponUsageLimit: 0 });
    await db.payment.updateMany({
      where: { id: payment.id },
      data: { status: "PAID", paidAt: new Date() },
    });

    const r = await processPaymentConfirmation({ paymentId: payment.id });
    expect(r.ok).toBe(true);
    const paid = await db.payment.findUnique({ where: { id: payment.id } });
    expect(paid?.subscriptionId).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* billing-3: refund race                                              */
/* ------------------------------------------------------------------ */

describe("billing-3 — refund concurrency guard", () => {
  test("two concurrent full refunds: exactly one applies, the loser is told to retry", async () => {
    const { payment, adminUserId } = await fixture();
    await markPaymentPaid({ paymentId: payment.id, reason: "paid" });

    const [a, b] = await Promise.all([
      refundPayment({ paymentId: payment.id, adminUserId, reason: "double click A" }),
      refundPayment({ paymentId: payment.id, adminUserId, reason: "double click B" }),
    ]);
    const okCount = [a, b].filter((r) => r.ok).length;
    expect(okCount).toBe(1);

    const paid = await db.payment.findUnique({ where: { id: payment.id } });
    expect(paid?.refundedAmount).toBeLessThanOrEqual(paid!.amount);
    expect(paid?.status).toBe("REFUNDED");
  });

  test("sequential partial refunds cannot exceed the payment amount", async () => {
    const { payment, adminUserId } = await fixture();
    await markPaymentPaid({ paymentId: payment.id, reason: "paid" });

    // 900 + 899 = 1799 = the full amount (exhausts the payment).
    const first = await refundPayment({
      paymentId: payment.id,
      adminUserId,
      reason: "partial 1",
      amount: 900,
    });
    expect(first.ok).toBe(true);
    const second = await refundPayment({
      paymentId: payment.id,
      adminUserId,
      reason: "partial 2",
      amount: 899,
    });
    expect(second.ok).toBe(true);
    // Nothing left — the third attempt is honestly refused.
    const third = await refundPayment({
      paymentId: payment.id,
      adminUserId,
      reason: "over-refund",
      amount: 100,
    });
    expect(third.ok).toBe(false);

    const paid = await db.payment.findUnique({ where: { id: payment.id } });
    expect(paid?.refundedAmount).toBe(1799);
    expect(paid?.status).toBe("REFUNDED");
  });
});

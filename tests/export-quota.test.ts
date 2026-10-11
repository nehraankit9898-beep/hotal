/**
 * Export quota atomic reservation — regression tests for quota-1:
 *
 *  The `exports` usage counter was NEVER incremented anywhere, so a plan's
 *  exportsLimit was decorative. reserveUsage now performs check+increment as
 *  ONE guarded update (`used < limit`), making the limit race-free; failed
 *  exports give the reservation back (releaseUsage).
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

import { reserveUsage, releaseUsage, getUsage } from "../src/lib/saas/limits";

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

async function hotelWithExportsLimit(exportsLimit: number) {
  const plan = await db.plan.create({
    data: {
      name: `QPLAN-${Math.random().toString(36).slice(2, 8)}`,
      key: `qplan-${Math.random().toString(36).slice(2, 10)}`,
      monthlyPrice: 999,
      yearlyPrice: 9990,
      exportsLimit,
    },
  });
  const hotel = await db.hotel.create({
    data: {
      name: "Quota Hotel",
      planId: plan.id,
      tenantId: `T-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    },
  });
  return hotel;
}

describe("quota-1 — atomic export reservation", () => {
  test("reservations actually increment usage (the old code never did)", async () => {
    const hotel = await hotelWithExportsLimit(5);
    const first = await reserveUsage(hotel.id, "exports", { skipAudit: true });
    expect(first).toBeNull();
    expect(await getUsage(hotel.id, "exports")).toBe(1);
  });

  test("the limit is enforced: the (limit+1)-th reservation is rejected", async () => {
    const hotel = await hotelWithExportsLimit(2);
    expect(await reserveUsage(hotel.id, "exports", { skipAudit: true })).toBeNull();
    expect(await reserveUsage(hotel.id, "exports", { skipAudit: true })).toBeNull();
    const denied = await reserveUsage(hotel.id, "exports", { skipAudit: true });
    expect(denied).not.toBeNull();
    expect(denied?.code).toBe("SUBSCRIPTION_LIMIT_REACHED");
    expect(denied?.used).toBe(2);
    expect(denied?.limit).toBe(2);
    // Usage never exceeded the limit.
    expect(await getUsage(hotel.id, "exports")).toBe(2);
  });

  test("N concurrent reservations can never push usage past the limit", async () => {
    const limit = 3;
    const hotel = await hotelWithExportsLimit(limit);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reserveUsage(hotel.id, "exports", { skipAudit: true })),
    );
    const granted = results.filter((r) => r === null).length;
    expect(granted).toBe(limit); // exactly the limit, not more
    expect(await getUsage(hotel.id, "exports")).toBe(limit);
  });

  test("unlimited plans (limit 0) never consume the counter", async () => {
    const hotel = await hotelWithExportsLimit(0);
    for (let i = 0; i < 5; i++) {
      expect(await reserveUsage(hotel.id, "exports", { skipAudit: true })).toBeNull();
    }
    expect(await getUsage(hotel.id, "exports")).toBe(0);
  });

  test("releaseUsage gives a failed export its slot back (never below zero)", async () => {
    const hotel = await hotelWithExportsLimit(1);
    expect(await reserveUsage(hotel.id, "exports", { skipAudit: true })).toBeNull();
    expect(await reserveUsage(hotel.id, "exports", { skipAudit: true })).not.toBeNull(); // exhausted

    await releaseUsage(hotel.id, "exports");
    expect(await getUsage(hotel.id, "exports")).toBe(0);
    expect(await reserveUsage(hotel.id, "exports", { skipAudit: true })).toBeNull(); // slot available again

    // Releasing more than was reserved cannot go negative.
    await releaseUsage(hotel.id, "exports");
    await releaseUsage(hotel.id, "exports");
    expect(await getUsage(hotel.id, "exports")).toBeGreaterThanOrEqual(0);
  });

  test("quota is per hotel — a second hotel has its own budget", async () => {
    const hotelA = await hotelWithExportsLimit(1);
    const hotelB = await hotelWithExportsLimit(1);
    expect(await reserveUsage(hotelA.id, "exports", { skipAudit: true })).toBeNull();
    expect(await reserveUsage(hotelB.id, "exports", { skipAudit: true })).toBeNull(); // independent
    expect(await reserveUsage(hotelA.id, "exports", { skipAudit: true })).not.toBeNull();
    expect(await reserveUsage(hotelB.id, "exports", { skipAudit: true })).not.toBeNull();
  });
});

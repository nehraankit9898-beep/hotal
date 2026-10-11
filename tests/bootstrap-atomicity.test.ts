/**
 * First-super-admin bootstrap atomicity — regression test for bootstrap-1:
 *
 *  The old count-then-create allowed two CONCURRENT bootstrap invocations to
 *  both pass the count check and create TWO Super Admins. The PlatformSetting
 *  CAS claim ("false" → "true") guarantees exactly one winner; the loser gets
 *  the honest "already exists" error. A failed create releases the claim so
 *  the operator can retry.
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

import { bootstrapFirstSuperAdmin } from "../src/lib/super-admin";

const CLAIM_KEY = "bootstrap.super_admin.claimed";

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

function secret(): string {
  return "bootstrap-secret-0123456789abcdef-" + Math.random().toString(36).slice(2);
}

describe("bootstrap-1 — atomic first-super-admin creation", () => {
  test("two CONCURRENT bootstraps: exactly one Super Admin is created", async () => {
    const results = await Promise.allSettled([
      bootstrapFirstSuperAdmin({
        name: "A",
        email: `race-a-${Date.now()}@test.local`,
        bootstrapSecret: secret(),
      }),
      bootstrapFirstSuperAdmin({
        name: "B",
        email: `race-b-${Date.now()}@test.local`,
        bootstrapSecret: secret(),
      }),
    ]);
    const winners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r) => r.status === "rejected");

    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    const loserReason =
      losers[0].status === "rejected" ? String(losers[0].reason?.message ?? losers[0].reason) : "";
    expect(loserReason).toContain("already exists");

    const superAdmins = await db.user.count({ where: { role: "SUPER_ADMIN" } });
    expect(superAdmins).toBe(1);
    // The claim row stays claimed (one-shot bootstrap, ever).
    const claim = await db.platformSetting.findUnique({ where: { key: CLAIM_KEY } });
    expect(claim?.value).toBe("true");
  });

  test("sequential re-bootstrap is refused after success", async () => {
    await expect(
      bootstrapFirstSuperAdmin({
        name: "C",
        email: `seq-c-${Date.now()}@test.local`,
        bootstrapSecret: secret(),
      }),
    ).rejects.toThrow(/already exists/i);
    expect(await db.user.count({ where: { role: "SUPER_ADMIN" } })).toBe(1);
  });

  test("the winner's account is mustChangePassword with an unusable-till-changed password", async () => {
    const sa = await db.user.findFirst({ where: { role: "SUPER_ADMIN" } });
    expect(sa?.mustChangePassword).toBe(true);
    expect(sa?.status).toBe("ACTIVE");
  });
});

describe("bootstrap-1 — claim release on failure", () => {
  test("a duplicate-email failure releases the claim so a retry with a fresh email works", async () => {
    // Currently one super admin exists (from the previous describe). Move it
    // aside to simulate a FRESH database, and set the claim row to "false".
    const existing = await db.user.findFirst({ where: { role: "SUPER_ADMIN" } });
    await db.user.delete({ where: { id: existing!.id } });
    await db.platformSetting.upsert({
      where: { key: CLAIM_KEY },
      create: { key: CLAIM_KEY, value: "false" },
      update: { value: "false" },
    });
    // Leave a user that will collide with the bootstrap email.
    const blocker = await db.user.create({
      data: {
        name: "Blocker",
        email: "blocked-email@test.local",
        passwordHash: "x".repeat(60),
        role: "HOTEL_ADMIN",
        status: "ACTIVE",
      },
    });

    // Attempt 1 fails on the email collision → claim must be released.
    await expect(
      bootstrapFirstSuperAdmin({
        name: "D",
        email: "blocked-email@test.local",
        bootstrapSecret: secret(),
      }),
    ).rejects.toThrow(/already exists/i);
    let claim = await db.platformSetting.findUnique({ where: { key: CLAIM_KEY } });
    expect(claim?.value).toBe("false"); // released — retry is possible

    // Attempt 2 with a fresh email succeeds.
    const ok = await bootstrapFirstSuperAdmin({
      name: "D2",
      email: `fresh-${Date.now()}@test.local`,
      bootstrapSecret: secret(),
    });
    expect(ok.mustChangePassword).toBe(true);
    claim = await db.platformSetting.findUnique({ where: { key: CLAIM_KEY } });
    expect(claim?.value).toBe("true");

    await db.user.delete({ where: { id: blocker.id } }).catch(() => undefined);
  });
});

/**
 * Backup schedule claim — regression tests for backup-1/backup-2:
 *
 *  backup-1: the scheduled-backup decision is a DB-level CAS on a
 *    PlatformSetting row + the PENDING record created in the SAME
 *    transaction. N concurrent claims → exactly ONE scheduled record; a
 *    FAILED attempt fences retries for the retry window instead of stalling
 *    forever; a SUCCESS closes the gate until the next due time.
 *  backup-2: archive filenames embed the record id → unique even for
 *    same-millisecond backups.
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
  claimScheduledBackup,
  backupArchiveFilename,
  BACKUP_SCHEDULE_RETRY_MS,
} from "../src/lib/saas/backup";
import { invalidateSettingsCache } from "../src/lib/saas/settings";

/** Direct PlatformSetting write (setSetting's parameter type is a literal
 *  union from the `as const` DEFAULT_SETTINGS — tests need dynamic values). */
async function setBackupConfig(cfg: {
  enabled: boolean;
  scheduleHours: number;
  retentionCount: number;
  verify: boolean;
}) {
  await db.platformSetting.upsert({
    where: { key: "backup" },
    create: { key: "backup", value: JSON.stringify(cfg) },
    update: { value: JSON.stringify(cfg) },
  });
  invalidateSettingsCache();
}

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
  await setBackupConfig({ enabled: true, scheduleHours: 24, retentionCount: 10, verify: false });
}, 180_000);

afterAll(async () => {
  await db.$disconnect();
  cleanupQueueTestTmp();
});

const CLAIM_KEY = "backup.schedule.claim";

async function claimRow(): Promise<string | null> {
  const row = await db.platformSetting.findUnique({ where: { key: CLAIM_KEY } });
  return row?.value ?? null;
}

describe("backup-1 — DB-level schedule claim", () => {
  test("disabled schedule never claims", async () => {
    await setBackupConfig({ enabled: false, scheduleHours: 24, retentionCount: 10, verify: false });
    const claimed = await claimScheduledBackup();
    expect(claimed).toBeNull();
    await setBackupConfig({ enabled: true, scheduleHours: 24, retentionCount: 10, verify: false });
  });

  test("first claim wins and creates exactly ONE PENDING record", async () => {
    const claimed = await claimScheduledBackup();
    expect(claimed).not.toBeNull();
    const record = await db.backupRecord.findUnique({ where: { id: claimed!.recordId } });
    expect(record?.status).toBe("PENDING");
    expect(record?.triggerReason).toBe("scheduled");
  });

  test("concurrent claims: exactly one winner (the CAS fences the others)", async () => {
    // Backdate the claim row so this test is independent of the previous
    // test's 15-minute fence.
    await db.platformSetting.update({
      where: { key: CLAIM_KEY },
      data: { value: new Date(0).toISOString() },
    });
    const before = await db.backupRecord.count({ where: { triggerReason: "scheduled" } });

    const results = await Promise.all([
      claimScheduledBackup(),
      claimScheduledBackup(),
      claimScheduledBackup(),
      claimScheduledBackup(),
    ]);
    const winners = results.filter((r) => r !== null);
    expect(winners.length).toBe(1);

    const after = await db.backupRecord.count({ where: { triggerReason: "scheduled" } });
    expect(after).toBe(before + 1); // exactly one new record from 4 racers
  });

  test("the claim fences retries until the retry window passes (failure path)", async () => {
    const before = await db.backupRecord.count({ where: { triggerReason: "scheduled" } });
    // Immediately after a claim, another claim is fenced…
    expect(await claimScheduledBackup()).toBeNull();

    // …but after the retry window (15 min), a retry is allowed — the old
    // logic stalled FOREVER after a failed scheduled backup.
    const future = new Date(Date.now() + BACKUP_SCHEDULE_RETRY_MS + 1000);
    const retry = await claimScheduledBackup({ now: future });
    expect(retry).not.toBeNull();
    const after = await db.backupRecord.count({ where: { triggerReason: "scheduled" } });
    expect(after).toBe(before + 1);
  });

  test("a SUCCESSFUL backup closes the gate until lastSuccess + scheduleHours", async () => {
    // Mark all scheduled records as successful, finished recently.
    await db.backupRecord.updateMany({
      where: { triggerReason: "scheduled" },
      data: { status: "SUCCESS", finishedAt: new Date() },
    });
    invalidateSettingsCache();
    // Not due yet (24h schedule, last success just now).
    expect(await claimScheduledBackup()).toBeNull();

    // After the full interval it is due again.
    const later = new Date(Date.now() + 24 * 60 * 60 * 1000 + 60_000);
    const due = await claimScheduledBackup({ now: later });
    expect(due).not.toBeNull();
  });

  test("the claim row advances monotonically (ISO CAS value)", async () => {
    const value = await claimRow();
    expect(value).not.toBeNull();
    expect(Date.parse(value!)).not.toBeNaN();
    expect(Date.parse(value!)).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("backup-2 — unique archive filenames", () => {
  test("filenames embed the record id and differ for same-millisecond records", () => {
    const a = backupArchiveFilename(
      "11111111-2222-3332-4444-aaaaaaaaaaaa",
      new Date("2026-10-09T10:00:00.000Z"),
    );
    const b = backupArchiveFilename(
      "11111111-2222-3333-4444-bbbbbbbbbbbb",
      new Date("2026-10-09T10:00:00.000Z"),
    );
    expect(a).not.toBe(b);
    expect(a).toMatch(/^stayloop-backup-2026-10-09T10-00-00-000Z-[0-9a-f]{8}\.slbkp\.enc$/);
    expect(b).toMatch(/-[0-9a-f]{8}\.slbkp\.enc$/);
    expect(a.endsWith("aaaaaaaa.slbkp.enc")).toBe(true);
    expect(b.endsWith("bbbbbbbb.slbkp.enc")).toBe(true);
  });

  test("same record + same time is deterministic (idempotent naming)", () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000";
    expect(backupArchiveFilename(id, new Date(0))).toBe(backupArchiveFilename(id, new Date(0)));
  });
});

/**
 * Ops reliability — regression tests for the Phase 10 audit fixes:
 *
 *  - Backup verification performs a REAL AES-256-GCM decryption (auth tag
 *    checked), detects tampering, checksum mismatches, and supports
 *    encryption-key rotation via INTEGRATION_ENCRYPTION_PREVIOUS_KEYS.
 *  - Production email honesty: with no provider configured, sends FAIL
 *    explicitly (no silent mock success). The mock stays dev/test-only.
 *  - Worker heartbeat status classification (ok / stale / unknown).
 */
import "./queue-test-env";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PrismaClient } from "@prisma/client";

const backupDir = mkdtempSync(join(tmpdir(), "stayloop-ops-backup-"));

import { encryptArchive, verifyBackup, decryptArchive } from "../src/lib/saas/backup";
import { getEmailProvider, emailTransportStatus } from "../src/lib/providers/email";
import { __resetEncryptionKeyCacheForTests } from "../src/lib/config";
import {
  workerHeartbeatStatus,
  setWorkerHeartbeat,
  WORKER_HEARTBEAT_KEY,
} from "../src/lib/worker-heartbeat";

const db = new PrismaClient({
  datasources: { db: { url: `${process.env.DATABASE_URL}?connection_limit=1` } },
});

beforeAll(async () => {
  process.env.BACKUP_DIR = backupDir;
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "PlatformSetting" (
      "key" TEXT NOT NULL PRIMARY KEY,
      "value" TEXT NOT NULL,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

afterAll(async () => {
  await db.$disconnect();
  try {
    rmSync(backupDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("backup encryption + verification (real AES-256-GCM)", () => {
  test("encrypt → verify round trip passes with the recorded checksum", async () => {
    const src = join(backupDir, "plain.dump");
    const dest = join(backupDir, "round.slbkp.enc");
    writeFileSync(src, Buffer.from("hello stayloop backup corpus 123"));
    const { checksum } = await encryptArchive(src, dest);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    const verdict = await verifyBackup(dest, checksum);
    expect(verdict.ok).toBe(true);
    // Null expected-checksum: decrypt still must succeed.
    expect((await verifyBackup(dest, null)).ok).toBe(true);
  });

  test("verification DECRYPTS: a tampered ciphertext fails (auth tag)", async () => {
    const src = join(backupDir, "plain2.dump");
    const dest = join(backupDir, "tampered.slbkp.enc");
    writeFileSync(src, Buffer.from("sensitive plaintext bytes"));
    const { checksum } = await encryptArchive(src, dest);
    // Flip one byte in the ciphertext region (beyond header+nonce+tag).
    const raw = readFileSync(dest);
    raw[raw.length - 1] ^= 0xff;
    writeFileSync(dest, raw);
    const verdict = await verifyBackup(dest, checksum);
    // Either the tag check fails or the checksum no longer matches — both are
    // honest failures. It must NOT report ok.
    expect(verdict.ok).toBe(false);
  });

  test("checksum mismatch is detected even when decryption succeeds", async () => {
    const src = join(backupDir, "plain3.dump");
    const dest = join(backupDir, "mismatch.slbkp.enc");
    writeFileSync(src, Buffer.from("some other content"));
    await encryptArchive(src, dest);
    // Recorded checksum of a DIFFERENT file → mismatch.
    const verdict = await verifyBackup(dest, "0".repeat(64));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("checksum_mismatch");
  });

  test("missing / corrupt archives fail cleanly", async () => {
    expect((await verifyBackup(join(backupDir, "missing.slbkp.enc"), null)).reason).toBe("missing");
    const bogus = join(backupDir, "bogus.slbkp.enc");
    writeFileSync(bogus, Buffer.from("not an archive"));
    expect((await verifyBackup(bogus, null)).ok).toBe(false);
  });

  test("key rotation: archive verifies via INTEGRATION_ENCRYPTION_PREVIOUS_KEYS", async () => {
    // Encrypt with the current key, then "rotate": current becomes previous
    // and a new current key is set. The old archive must still verify.
    //
    // PHASE 11 FIX (test-fixture env restoration): the previous value of
    // INTEGRATION_ENCRYPTION_KEY may be UNDEFINED (the harness does not set
    // one in test runs). Assigning `undefined` back into process.env coerces
    // to the literal string "undefined" — polluting every LATER test with an
    // invalid hex key and failing backup validation suites that run after
    // this one. The restoration now DELETES the variable when it was unset,
    // and runs in a finally block so a failed assertion can never leak the
    // rotated keys either. The key cache is reset after restoration.
    const oldKey = "aa".repeat(32);
    const newKey = "bb".repeat(32);
    const src = join(backupDir, "plain4.dump");
    const dest = join(backupDir, "rotated.slbkp.enc");
    writeFileSync(src, Buffer.from("rotated key archive"));

    const prevKeyEnv = process.env.INTEGRATION_ENCRYPTION_KEY;
    const prevKeysEnv = process.env.INTEGRATION_ENCRYPTION_PREVIOUS_KEYS;
    try {
      process.env.INTEGRATION_ENCRYPTION_KEY = oldKey;
      __resetEncryptionKeyCacheForTests();
      const { checksum } = await encryptArchive(src, dest);

      // Rotate: new current key, old key declared as previous (id "old").
      process.env.INTEGRATION_ENCRYPTION_KEY = newKey;
      __resetEncryptionKeyCacheForTests();
      process.env.INTEGRATION_ENCRYPTION_PREVIOUS_KEYS = `old:${oldKey}`;
      // The archive header names the "default" key id, but its bytes were
      // encrypted with the OLD key — verification must fall back through the
      // candidate list to the declared previous key.
      const verdict = await verifyBackup(dest, checksum);
      expect(verdict.ok).toBe(true);

      // Without the previous key declared, the archive is NOT verifiable.
      process.env.INTEGRATION_ENCRYPTION_PREVIOUS_KEYS = "";
      const denied = await verifyBackup(dest, checksum);
      expect(denied.ok).toBe(false);
    } finally {
      // Restore test env EXACTLY as it was: unset stays unset (delete, never
      // assign undefined — that coerces to the string "undefined" and breaks
      // every later consumer of the key).
      if (prevKeyEnv === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
      else process.env.INTEGRATION_ENCRYPTION_KEY = prevKeyEnv;
      if (prevKeysEnv === undefined) delete process.env.INTEGRATION_ENCRYPTION_PREVIOUS_KEYS;
      else process.env.INTEGRATION_ENCRYPTION_PREVIOUS_KEYS = prevKeysEnv;
      __resetEncryptionKeyCacheForTests();
    }
  });

  test("decryptArchive restores the exact plaintext", async () => {
    const src = join(backupDir, "plain5.dump");
    const dest = join(backupDir, "round2.slbkp.enc");
    const out = join(backupDir, "restored.dump");
    const corpus = Buffer.from("PGDMP-custom-format-like-bytes".repeat(50));
    writeFileSync(src, corpus);
    await encryptArchive(src, dest);
    await decryptArchive(dest, out);
    expect(readFileSync(out).equals(corpus)).toBe(true);
  });

  test("streaming encryption does not buffer the source in memory observably", async () => {
    // 8 MB corpus — the streaming implementation processes it in chunks;
    // success + integrity is the observable contract here.
    const src = join(backupDir, "big.dump");
    const dest = join(backupDir, "big.slbkp.enc");
    const corpus = Buffer.alloc(8 * 1024 * 1024, 7);
    writeFileSync(src, corpus);
    const { checksum } = await encryptArchive(src, dest);
    expect((await verifyBackup(dest, checksum)).ok).toBe(true);
    const out = join(backupDir, "big.restored");
    await decryptArchive(dest, out);
    expect(readFileSync(out).equals(corpus)).toBe(true);
    expect(existsSync(src)).toBe(true);
  });
});

describe("email honesty (production must not mock)", () => {
  const prevEnv: Record<string, string | undefined> = {};
  const tracked = ["NODE_ENV", "EMAIL_PROVIDER", "SMTP_URL", "RESEND_API_KEY", "SENDGRID_API_KEY"];

  beforeAll(() => {
    for (const k of tracked) prevEnv[k] = process.env[k];
  });
  afterAll(() => {
    for (const k of tracked) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k] as string;
    }
  });

  test("production without a provider fails explicitly — never a mock success", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.EMAIL_PROVIDER;
    delete process.env.SMTP_URL;
    delete process.env.RESEND_API_KEY;
    delete process.env.SENDGRID_API_KEY;
    const provider = getEmailProvider();
    expect(provider.id).toBe("UNCONFIGURED");
    const result = await provider.sendEmail({
      to: "x@example.com",
      subject: "s",
      html: "<p>x</p>",
      text: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("not configured");
    // Transport status reports honestly.
    expect(emailTransportStatus()).toBe("unconfigured");
  });

  test("development falls back to the mock outbox (dev/test only)", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    delete process.env.EMAIL_PROVIDER;
    delete process.env.SMTP_URL;
    delete process.env.RESEND_API_KEY;
    delete process.env.SENDGRID_API_KEY;
    expect(emailTransportStatus()).toBe("mock");
    const provider = getEmailProvider();
    expect(provider.id).toBe("MOCK_EMAIL");
    const result = await provider.sendEmail({
      to: "x@example.com",
      subject: "s",
      html: "<p>x</p>",
      text: "x",
    });
    expect(result.ok).toBe(true);
  });
});

describe("worker heartbeat classification", () => {
  test("fresh heartbeat → ok, stale → stale, absent → unknown", async () => {
    await setWorkerHeartbeat({ workerId: "w-test", at: Date.now(), pid: 1, jobsCompleted: 0 });
    expect(await workerHeartbeatStatus()).toBe("ok");

    await setWorkerHeartbeat({
      workerId: "w-test",
      at: Date.now() - 10 * 60 * 1000,
      pid: 1,
      jobsCompleted: 0,
    });
    expect(await workerHeartbeatStatus()).toBe("stale");

    await db.platformSetting.delete({ where: { key: WORKER_HEARTBEAT_KEY } });
    expect(await workerHeartbeatStatus()).toBe("unknown");
  });
});

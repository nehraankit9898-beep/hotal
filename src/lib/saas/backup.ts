import { createHash, createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { db, resolveSqlitePath } from "@/lib/db";
import { getIntegrationEncryptionKey, isProduction, isTest } from "@/lib/config";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { getSetting } from "@/lib/saas/settings";

/**
 * Backup & Disaster Recovery — Phase 10 §16, hardened for production.
 *
 * - SQLite (dev): copy the database file, AES-256-GCM encrypt the archive.
 * - PostgreSQL (prod): `pg_dump` via execFile (no shell interpolation —
 *   injection-safe argument array). Credentials are passed to pg_dump via
 *   ENVIRONMENT VARIABLES (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE), never
 *   on the command line (visible in `ps`/error output) and never in logs,
 *   audit records, API responses or reports.
 * - STREAMING AES-256-GCM encryption/decryption (audit fix: the previous
 *   whole-file readFileSync/writeFileSync approach loaded the entire dump in
 *   memory — a large database could OOM the worker; verification now streams).
 * - Every backup records a BackupRecord row (status, size, checksum,
 *   duration, verification) — the Super Admin dashboard reads those rows.
 * - Verification DECRYPTS the archive with AES-256-GCM (auth tag checked) and
 *   hashes the plaintext — it does not merely check the magic header and
 *   ciphertext checksum (audit fix).
 * - Key rotation: archives are self-describing (format V2 embeds a key id).
 *   Old V1 archives decrypt with every configured key; new archives use the
 *   current INTEGRATION_ENCRYPTION_KEY. Previous keys can be declared via
 *   INTEGRATION_ENCRYPTION_PREVIOUS_KEYS (comma-separated "<id>:<64hex>").
 * - Retention: oldest backups beyond backup.retentionCount are deleted.
 * - Concurrency: manual triggers create PENDING records; a worker claims
 *   them atomically (status-checked updateMany) so two workers never run the
 *   same backup. Stale RUNNING records are marked FAILED (crash recovery).
 * - Credentials never appear in responses — only filenames/sizes/status.
 */

const execFileAsync = promisify(execFile);

/** Persistent storage for backup archives (shared volume in production). */
export function backupDir(): string {
  return process.env.BACKUP_DIR
    ? path.resolve(process.env.BACKUP_DIR)
    : path.join(process.cwd(), "backups");
}

export function ensureBackupDir(): string {
  const dir = backupDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  }
  return dir;
}

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "";
}

function isSqlite(): boolean {
  return databaseUrl().startsWith("file:");
}

function sqliteFilePath(): string {
  // BUGFIX: resolve through the SAME logic the Prisma client uses
  // (src/lib/db.ts). Previously this resolved relative paths on its own and
  // ignored the stale-path fallback, so backups could target (and fail on) a
  // different file than the database the app is actually serving from.
  const resolved = resolveSqlitePath(databaseUrl());
  const url = resolved.replace(/^file:/, "").split("?")[0];
  return path.isAbsolute(url) ? url : path.resolve(process.cwd(), "prisma", url);
}

/* ------------------------------------------------------------------ */
/* AES-256-GCM archive format                                          */
/* ------------------------------------------------------------------ */

/**
 * V1 (legacy, still readable): MAGIC(8) "SLBKPV01" + nonce(12) + tag(16) + ciphertext.
 * V2 (current): MAGIC(8) "SLBKPV02" + keyIdLen(1) + keyId + nonce(12) + tag(16) + ciphertext.
 * The key id makes archives self-describing so encryption-key rotation keeps
 * old archives verifiable/decryptable (audit fix).
 */
const MAGIC_V1 = "SLBKPV01";
const MAGIC_V2 = "SLBKPV02";
const CURRENT_KEY_ID = "default";
const AAD = Buffer.from("stayloop-backup", "utf8");

interface NamedKey {
  id: string;
  key: Buffer;
}

/** Current key + operator-declared previous keys (rotation support). */
function encryptionKeys(): NamedKey[] {
  const keys: NamedKey[] = [{ id: CURRENT_KEY_ID, key: getIntegrationEncryptionKey() }];
  const previous = (process.env.INTEGRATION_ENCRYPTION_PREVIOUS_KEYS ?? "").trim();
  if (previous) {
    for (const entry of previous.split(",")) {
      const idx = entry.indexOf(":");
      if (idx <= 0) continue;
      const id = entry.slice(0, idx).trim();
      const hex = entry.slice(idx + 1).trim();
      if (!id || !/^[0-9a-fA-F]{64}$/.test(hex)) continue;
      keys.push({ id, key: Buffer.from(hex, "hex") });
    }
  }
  return keys;
}

/** Remove anything that looks like a credential from an error message. */
function sanitizeErrorMessage(message: string): string {
  return (
    message
      // connection strings / URLs with credentials
      .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s@/:]+:[^\s@/]+@[^\s]+/g, "[redacted-url]")
      // password=... assignments
      .replace(/\b(password|passphrase|pwd)\s*=\s*\S+/gi, "$1=[redacted]")
      .slice(0, 300)
  );
}

/* ------------------------------------------------------------------ */
/* Streaming encrypt / decrypt                                         */
/* ------------------------------------------------------------------ */

/**
 * STREAMING encrypt: source file → AES-256-GCM → dest file.
 * Memory use is O(chunk size), not O(dump size). Returns the sha256 checksum
 * of the ENCRYPTED archive (what BackupRecord.checksum records).
 */
export function encryptArchive(
  sourcePath: string,
  destPath: string,
): Promise<{ checksum: string }> {
  const key = getIntegrationEncryptionKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD);
  const header = Buffer.concat([
    Buffer.from(MAGIC_V2, "utf8"),
    Buffer.from([CURRENT_KEY_ID.length]),
    Buffer.from(CURRENT_KEY_ID, "utf8"),
  ]);
  // The checksum covers EXACTLY the bytes on disk (what verification re-hashes):
  // header + nonce + ciphertext + tag.
  const hash = createHash("sha256");
  hash.update(header);
  hash.update(nonce);

  // ON-DISK LAYOUT: MAGIC(8) + keyIdLen(1) + keyId + nonce(12) + ciphertext + tag(16, AT END).
  // The tag is only available after cipher.final(), so it is appended last —
  // verification/decryption stream the middle and read the tag from the tail.
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(sourcePath);
    const output = fs.createWriteStream(destPath, { mode: 0o640 });
    // The self-describing header (magic + key id) + nonce are the FIRST things on disk.
    output.write(header);
    output.write(nonce);
    const fail = (err: Error) => {
      input.destroy();
      output.destroy();
      try {
        fs.rmSync(destPath, { force: true });
      } catch {
        /* best effort */
      }
      reject(err);
    };
    input.on("error", fail);
    output.on("error", fail);
    input.on("data", (chunk) => {
      try {
        const buf = chunk as Buffer;
        const enc = cipher.update(buf);
        hash.update(enc);
        if (!output.write(enc)) {
          input.pause();
          output.once("drain", () => input.resume());
        }
      } catch (err) {
        fail(err as Error);
      }
    });
    input.on("end", () => {
      try {
        const tail = Buffer.concat([cipher.final(), cipher.getAuthTag()]);
        hash.update(tail);
        output.write(tail);
        output.end(() => resolve({ checksum: hash.digest("hex") }));
      } catch (err) {
        fail(err as Error);
      }
    });
  });
}

export interface VerifyResult {
  ok: boolean;
  /** Why verification failed (safe to expose — never contains credentials). */
  reason?: "missing" | "corrupt" | "checksum_mismatch" | "decrypt_failed";
}

/**
 * Parse the archive header (magic + optional key id) and the nonce that
 * follows it; read the AES-GCM tag from the LAST 16 bytes of the file.
 * Returns offsets so callers can STREAM the ciphertext between them instead
 * of loading the whole archive into memory.
 *
 * ON-DISK LAYOUT: MAGIC(8) + keyIdLen(1) + keyId + nonce(12) + ciphertext + tag(16)
 */
function readArchiveHeader(storagePath: string):
  | {
      ok: true;
      keyId: string;
      dataStart: number; // first ciphertext byte
      dataEnd: number; // last ciphertext byte (inclusive)
      nonce: Buffer;
      tag: Buffer;
    }
  | { ok: false; reason: "corrupt" | "magic" } {
  let fh: number | null = null;
  try {
    const stat = fs.statSync(storagePath);
    if (stat.size < 40) return { ok: false, reason: "corrupt" };
    fh = fs.openSync(storagePath, "r");
    const magic = Buffer.alloc(8);
    if (fs.readSync(fh, magic, 0, 8, 0) !== 8) return { ok: false, reason: "corrupt" };
    let keyId = "";
    let bodyStart = 8;
    if (magic.toString("utf8") === MAGIC_V2) {
      const len = Buffer.alloc(1);
      if (fs.readSync(fh, len, 0, 1, 8) !== 1) return { ok: false, reason: "corrupt" };
      const idBuf = Buffer.alloc(len[0]);
      if (fs.readSync(fh, idBuf, 0, idBuf.length, 9) !== idBuf.length)
        return { ok: false, reason: "corrupt" };
      keyId = idBuf.toString("utf8");
      bodyStart = 9 + idBuf.length;
    } else if (magic.toString("utf8") !== MAGIC_V1) {
      return { ok: false, reason: "magic" };
    }
    const nonce = Buffer.alloc(12);
    if (fs.readSync(fh, nonce, 0, 12, bodyStart) !== 12) return { ok: false, reason: "corrupt" };
    // Legacy V1 layout: MAGIC(8) + nonce(12) + tag(16) + ciphertext (tag in the middle).
    // V2 layout: tag is the last 16 bytes (streaming-friendly).
    const v1 = magic.toString("utf8") === MAGIC_V1;
    let tag: Buffer;
    let dataStart: number;
    let dataEnd: number;
    if (v1) {
      tag = Buffer.alloc(16);
      if (fs.readSync(fh, tag, 0, 16, bodyStart + 12) !== 16)
        return { ok: false, reason: "corrupt" };
      dataStart = bodyStart + 28;
      dataEnd = stat.size - 1;
    } else {
      tag = Buffer.alloc(16);
      if (fs.readSync(fh, tag, 0, 16, stat.size - 16) !== 16)
        return { ok: false, reason: "corrupt" };
      dataStart = bodyStart + 12;
      dataEnd = stat.size - 17;
    }
    if (dataEnd < dataStart) return { ok: false, reason: "corrupt" };
    return { ok: true, keyId, dataStart, dataEnd, nonce, tag };
  } finally {
    if (fh !== null) fs.closeSync(fh);
  }
}

/** Candidate keys for an archive: named key first, then all others. */
function candidateKeys(keyId: string): NamedKey[] {
  const keys = encryptionKeys();
  return keyId
    ? [...keys.filter((k) => k.id === keyId), ...keys.filter((k) => k.id !== keyId)]
    : keys;
}

/**
 * STREAMING verify: the archive must decrypt with AES-256-GCM (the auth tag
 * is CHECKED by the cipher — tampered/truncated ciphertext fails), and the
 * full file sha256 must match the recorded checksum. This is a REAL
 * decryption pass over the whole archive, streamed — not a header sniff and
 * not a whole-file buffer (audit fix).
 */
export async function verifyBackup(
  storagePath: string,
  expectedChecksum: string | null,
): Promise<VerifyResult> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(storagePath);
  } catch {
    return { ok: false, reason: "missing" };
  }

  const header = readArchiveHeader(storagePath);
  if (!header.ok) return { ok: false, reason: "corrupt" };
  const { keyId, dataStart, dataEnd, nonce, tag } = header;

  // Pass 1 (when a checksum is recorded): stream the WHOLE file, in order,
  // through sha256 — the digest must equal the recorded ciphertext checksum.
  if (expectedChecksum) {
    const digest = await hashFileStream(storagePath, 0, stat.size - 1);
    if (digest !== expectedChecksum) return { ok: false, reason: "checksum_mismatch" };
  }

  // Pass 2: real AES-256-GCM decryption of the ciphertext window (auth tag
  // checked by decipher.final()). Candidate keys are tried in order — the
  // named key first, then rotation keys (legacy archives).
  const candidates = candidateKeys(keyId);
  for (const candidate of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      const decipher = createDecipheriv("aes-256-gcm", candidate.key, nonce);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      const input = fs.createReadStream(storagePath, { start: dataStart, end: dataEnd });
      let failed = false;
      input.on("data", (chunk) => {
        try {
          decipher.update(chunk as Buffer);
        } catch {
          failed = true;
          input.destroy();
        }
      });
      input.on("error", () => resolve(false));
      input.on("close", () => {
        if (failed) {
          resolve(false);
          return;
        }
        try {
          decipher.final(); // throws when the auth tag does not match
          resolve(true);
        } catch {
          resolve(false);
        }
      });
    });
    if (ok) return { ok: true };
  }
  return { ok: false, reason: "decrypt_failed" };
}

/** Stream bytes [start..end] (inclusive) of a file through sha256. */
function hashFileStream(storagePath: string, start: number, end: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = fs.createReadStream(storagePath, { start, end });
    input.on("data", (chunk) => hash.update(chunk as Buffer));
    input.on("error", reject);
    input.on("close", () => resolve(hash.digest("hex")));
  });
}

/**
 * STREAMING decrypt for restores: archive → plaintext dump file. The
 * ciphertext window is streamed (never fully buffered); candidate keys are
 * tried in order (current key first, then rotation keys for legacy archives).
 */
export function decryptArchive(sourcePath: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const header = readArchiveHeader(sourcePath);
    if (!header.ok) {
      reject(new Error("Not a StayLoop backup archive (bad or corrupt header)."));
      return;
    }
    const { keyId, dataStart, dataEnd, nonce, tag } = header;
    const candidates = candidateKeys(keyId);

    const attempt = (index: number) => {
      if (index >= candidates.length) {
        reject(new Error("Backup archive could not be decrypted with any configured key."));
        return;
      }
      const decipher = createDecipheriv("aes-256-gcm", candidates[index].key, nonce);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      const input = fs.createReadStream(sourcePath, { start: dataStart, end: dataEnd });
      const output = fs.createWriteStream(destPath, { mode: 0o600 });
      let failed = false;
      const fail = (err: Error) => {
        if (failed) return;
        failed = true;
        input.destroy();
        output.destroy();
        try {
          fs.rmSync(destPath, { force: true });
        } catch {
          /* best effort */
        }
        if (index + 1 < candidates.length) {
          attempt(index + 1); // wrong key — try the next candidate
        } else {
          reject(err);
        }
      };
      input.on("error", fail);
      output.on("error", fail);
      input.on("data", (chunk) => {
        try {
          const out = decipher.update(chunk as Buffer);
          if (out.length && !output.write(out)) {
            input.pause();
            output.once("drain", () => input.resume());
          }
        } catch (err) {
          fail(err as Error);
        }
      });
      input.on("close", () => {
        if (failed) return;
        try {
          const tail = decipher.final(); // throws on auth-tag mismatch
          if (tail.length) output.write(tail);
          output.end(() => resolve());
        } catch (err) {
          fail(err as Error);
        }
      });
    };
    attempt(0);
  });
}

/* ------------------------------------------------------------------ */
/* pg_dump execution (PostgreSQL)                                      */
/* ------------------------------------------------------------------ */

interface ParsedDbUrl {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

/** Parse DATABASE_URL into connection parameters (never logged). */
function parsePostgresUrl(url: string): ParsedDbUrl | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") return null;
    return {
      host: u.hostname || "localhost",
      port: u.port || "5432",
      user: decodeURIComponent(u.username || "stayloop"),
      password: decodeURIComponent(u.password || ""),
      database: u.pathname.replace(/^\//, "") || "stayloop",
    };
  } catch {
    return null;
  }
}

/**
 * Execute pg_dump with credentials ONLY in the environment (never argv).
 * SSL parameters from the URL (sslmode) are forwarded via PGSSLMODE.
 */
async function pgDumpToFile(targetPath: string): Promise<void> {
  const parsed = parsePostgresUrl(databaseUrl());
  if (!parsed) {
    throw new Error("DATABASE_URL is not a valid PostgreSQL connection string.");
  }
  const sslmode = new URL(databaseUrl()).searchParams.get("sslmode") ?? "prefer";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: parsed.host,
    PGPORT: parsed.port,
    PGUSER: parsed.user,
    PGPASSWORD: parsed.password, // pg_dump reads this; never printed, never in argv
    PGDATABASE: parsed.database,
    PGSSLMODE: sslmode,
  };
  try {
    const out = await execFileAsync(
      "pg_dump",
      ["--format=custom", "--no-password", `--file=${targetPath}`],
      { timeout: 10 * 60 * 1000, env },
    );
    if (out.stderr && /error|fatal/i.test(out.stderr)) {
      // stderr can contain host/user info — sanitize before persisting.
      throw new Error(sanitizeErrorMessage(`pg_dump failed: ${out.stderr.slice(0, 300)}`));
    }
  } catch (err) {
    const execErr = err as { stderr?: string; message?: string; code?: string };
    if (execErr.code === "ENOENT") {
      throw new Error(
        "pg_dump is not installed in this container. The worker image must include postgresql-client (see Dockerfile).",
      );
    }
    throw new Error(sanitizeErrorMessage(execErr.stderr || execErr.message || "pg_dump failed"));
  }
}

/* ------------------------------------------------------------------ */
/* Backup lifecycle                                                    */
/* ------------------------------------------------------------------ */

export interface BackupResult {
  recordId: string;
  status: "SUCCESS" | "FAILED";
  filename: string | null;
  sizeBytes: number;
  error?: string;
}

/** Execute a backup now (worker: scheduled + queued manual records). */
export async function runBackup(params: {
  recordId: string;
  triggeredBy?: string | null;
  reason?: string;
}): Promise<BackupResult> {
  const startedAt = new Date();
  // Atomic PENDING → RUNNING claim (concurrency-safe across workers).
  const claim = await db.backupRecord.updateMany({
    where: { id: params.recordId, status: "PENDING" },
    data: { status: "RUNNING", startedAt },
  });
  if (claim.count !== 1) {
    // Another worker already owns (or already ran) this record.
    return {
      recordId: params.recordId,
      status: "FAILED",
      filename: null,
      sizeBytes: 0,
      error: "already claimed",
    };
  }

  const dir = ensureBackupDir();
  const tmpPath = path.join(dir, `.tmp-${params.recordId}.dump`);
  const filename = backupArchiveFilename(params.recordId);
  const destPath = path.join(dir, filename);
  try {
    if (isTest()) {
      // Tests: deterministic small dump so backup logic is verifiable offline.
      fs.writeFileSync(tmpPath, Buffer.from(`test-backup:${params.recordId}`), { mode: 0o600 });
    } else if (isSqlite()) {
      const src = sqliteFilePath();
      if (!fs.existsSync(src)) throw new Error(`SQLite database not found at ${src}`);
      fs.copyFileSync(src, tmpPath);
    } else {
      // PostgreSQL via pg_dump — argument array (no shell), credentials via env.
      await pgDumpToFile(tmpPath);
    }
    const { checksum } = await encryptArchive(tmpPath, destPath);
    fs.rmSync(tmpPath, { force: true });
    const stat = fs.statSync(destPath);
    const backupConfig = await getSetting("backup");
    let verifiedAt: Date | null = null;
    if (backupConfig.verify) {
      const verdict = await verifyBackup(destPath, checksum);
      verifiedAt = verdict.ok ? new Date() : null;
      if (!verifiedAt) {
        throw new Error(`Backup verification failed (${verdict.reason ?? "unknown"}).`);
      }
    }
    const finishedAt = new Date();
    await db.backupRecord.update({
      where: { id: params.recordId },
      data: {
        status: "SUCCESS",
        filename,
        sizeBytes: stat.size,
        checksum,
        storagePath: destPath,
        verifiedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      },
    });
    await logAudit({
      userId: params.triggeredBy ?? undefined,
      action: AUDIT_ACTIONS.BACKUP_COMPLETED,
      entityType: "backup",
      entityId: params.recordId,
      metadata: {
        filename,
        sizeBytes: stat.size,
        verified: Boolean(verifiedAt),
        reason: params.reason,
      },
    });
    await enforceRetention();
    return { recordId: params.recordId, status: "SUCCESS", filename, sizeBytes: stat.size };
  } catch (err) {
    const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    const finishedAt = new Date();
    await db.backupRecord.update({
      where: { id: params.recordId },
      data: {
        status: "FAILED",
        error: message.slice(0, 500),
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      },
    });
    await logAudit({
      userId: params.triggeredBy ?? undefined,
      action: AUDIT_ACTIONS.BACKUP_FAILED,
      entityType: "backup",
      entityId: params.recordId,
      metadata: { error: message.slice(0, 300), reason: params.reason },
    });
    // best-effort cleanup
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(destPath, { force: true });
    } catch {
      /* ignore */
    }
    return {
      recordId: params.recordId,
      status: "FAILED",
      filename: null,
      sizeBytes: 0,
      error: message,
    };
  }
}

/**
 * Create a PENDING record for a manual trigger. The WORKER picks it up within
 * seconds (processPendingBackups) — a queued backup is actually processed,
 * never left dangling (audit fix). Returns the record id immediately.
 */
export async function triggerBackup(params: {
  triggeredBy?: string | null;
  reason?: string;
}): Promise<{ recordId: string; queued: true }> {
  const record = await db.backupRecord.create({
    data: {
      status: "PENDING",
      triggeredBy: params.triggeredBy ?? null,
      triggerReason: params.reason ?? "manual",
    },
  });
  await logAudit({
    userId: params.triggeredBy ?? undefined,
    action: AUDIT_ACTIONS.BACKUP_TRIGGERED,
    entityType: "backup",
    entityId: record.id,
    metadata: { reason: params.reason ?? "manual", mode: "queued" },
  });
  return { recordId: record.id, queued: true };
}

/**
 * Claim and run PENDING backup records (worker sweep — every few seconds).
 * Only records not yet claimed are processed; the PENDING → RUNNING update
 * inside runBackup is the atomic claim, so concurrent workers never overlap.
 */
export async function processPendingBackups(
  opts: { triggerReason?: string } = {},
): Promise<number> {
  const pending = await db.backupRecord.findMany({
    where: {
      status: "PENDING",
      ...(opts.triggerReason ? { triggerReason: opts.triggerReason } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: 1,
  });
  let processed = 0;
  for (const record of pending) {
    const result = await runBackup({
      recordId: record.id,
      triggeredBy: record.triggeredBy,
      reason: record.triggerReason ?? "manual",
    });
    if (result.status !== "FAILED" || result.error !== "already claimed") {
      processed += 1;
      if (result.status === "FAILED") {
        // failed runs are recorded in the row itself — surfaced in history
      }
    }
  }
  return processed;
}

/* ------------------------------------------------------------------ */
/* Scheduled backups — DB-level schedule claim (audit fix backup-1)     */
/* ------------------------------------------------------------------ */

/**
 * PlatformSetting key holding the schedule claim (ISO timestamp of the next
 * moment a NEW scheduled backup may be created).
 */
const BACKUP_SCHEDULE_CLAIM_KEY = "backup.schedule.claim";

/** How long a failed scheduled attempt fences retries (15 minutes). */
export const BACKUP_SCHEDULE_RETRY_MS = 15 * 60 * 1000;

/**
 * AUDIT FIX (backup-1): atomic, cross-worker schedule claim.
 *
 * The old runScheduledBackup logic (worker.ts) decided "a backup is due" from
 * a plain read of the last SUCCESS record and then created a PENDING row:
 * with N workers running, ALL N decided simultaneously and produced N
 * backups per due period. Worse, the due time is computed from the last
 * SUCCESS — a single FAILED scheduled backup meant "due" stayed true
 * forever while nothing recorded progress, and retries never happened
 * because every worker just re-created another record that could also fail.
 *
 * This implementation gates on the schedule (last SUCCESS + scheduleHours),
 * then claims the period with a compare-and-swap on a PlatformSetting row:
 *
 *   updateMany({ key, value: { lt: now } })  →  value = now + retry fence
 *
 * Exactly ONE worker wins the CAS (the database serializes the update); the
 * claim and the PENDING record are created in the SAME transaction, so a
 * crash after claiming cannot lose the backup — the record exists and any
 * worker's pending-sweep picks it up. On SUCCESS the gate closes until the
 * next real due time; on FAILURE the claim only fences for 15 minutes, then
 * the schedule retries (no permanent stall).
 *
 * Returns the created record id, or null when no scheduled backup is due.
 */
export async function claimScheduledBackup(
  opts: {
    now?: Date;
    retryFenceMs?: number;
  } = {},
): Promise<{ recordId: string } | null> {
  const now = opts.now ?? new Date();
  const retryFenceMs = opts.retryFenceMs ?? BACKUP_SCHEDULE_RETRY_MS;
  const config = await getSetting("backup");
  if (!config.enabled) return null;

  // Schedule gate: due when (last SUCCESS + interval) is in the past — or
  // immediately when no backup has ever succeeded.
  const lastSuccess = await db.backupRecord.findFirst({
    where: { status: "SUCCESS" },
    orderBy: { createdAt: "desc" },
  });
  if (lastSuccess?.finishedAt) {
    const nextDue = lastSuccess.finishedAt.getTime() + config.scheduleHours * 60 * 60 * 1000;
    if (now.getTime() < nextDue) return null;
  }

  // Ensure the claim row exists (idempotent — the create only happens once).
  await db.platformSetting.upsert({
    where: { key: BACKUP_SCHEDULE_CLAIM_KEY },
    create: { key: BACKUP_SCHEDULE_CLAIM_KEY, value: new Date(0).toISOString() },
    update: {},
  });

  // CAS claim + PENDING record, atomically.
  let recordId: string | null = null;
  await db.$transaction(async (tx) => {
    const claim = await tx.platformSetting.updateMany({
      where: { key: BACKUP_SCHEDULE_CLAIM_KEY, value: { lt: now.toISOString() } },
      data: { value: new Date(now.getTime() + retryFenceMs).toISOString() },
    });
    if (claim.count !== 1) return; // another worker owns this period
    const record = await tx.backupRecord.create({
      data: { status: "PENDING", triggerReason: "scheduled" },
    });
    recordId = record.id;
  });
  return recordId ? { recordId } : null;
}

/**
 * AUDIT FIX (backup-2): unique archive filenames. The old name used only the
 * ISO timestamp (millisecond precision) — a manual and a scheduled backup (or
 * two workers) landing in the same millisecond produced the SAME filename and
 * one archive silently clobbered the other while both records pointed at it.
 * The record id (uuid) makes every filename unique; the ISO prefix keeps the
 * directory humanly sortable.
 */
export function backupArchiveFilename(recordId: string, at: Date = new Date()): string {
  const iso = at.toISOString().replace(/[:.]/g, "-");
  const suffix = recordId
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-8)
    .toLowerCase();
  return `stayloop-backup-${iso}-${suffix}.slbkp.enc`;
}

/**
 * Crash recovery: RUNNING backup records whose start is older than 30 minutes
 * are marked FAILED (the worker died mid-run) so the UI is never stuck.
 */
export async function recoverStaleBackups(staleAfterMs = 30 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const res = await db.backupRecord.updateMany({
    where: { status: "RUNNING", startedAt: { lt: cutoff } },
    data: {
      status: "FAILED",
      error: "Backup stuck in RUNNING (worker crash) — marked failed by recovery sweep",
      finishedAt: new Date(),
    },
  });
  return res.count;
}

/** Delete backups beyond the retention count (oldest first). */
export async function enforceRetention(): Promise<number> {
  const config = await getSetting("backup");
  const successes = await db.backupRecord.findMany({
    where: { status: "SUCCESS" },
    orderBy: { createdAt: "desc" },
    take: config.retentionCount + 50,
  });
  const excess = successes.slice(config.retentionCount);
  for (const record of excess) {
    if (record.storagePath) {
      try {
        fs.rmSync(record.storagePath, { force: true });
      } catch {
        /* ignore */
      }
    }
    await db.backupRecord.delete({ where: { id: record.id } });
  }
  return excess.length;
}

/** Backup status summary for the dashboard. */
export async function getBackupStatus() {
  const config = await getSetting("backup");
  const [lastSuccess, lastFailed, total, pending] = await Promise.all([
    db.backupRecord.findFirst({ where: { status: "SUCCESS" }, orderBy: { createdAt: "desc" } }),
    db.backupRecord.findFirst({ where: { status: "FAILED" }, orderBy: { createdAt: "desc" } }),
    db.backupRecord.count({ where: { status: "SUCCESS" } }),
    db.backupRecord.count({ where: { status: "PENDING" } }),
  ]);
  // Next scheduled backup = last success + scheduleHours
  const nextBackup =
    lastSuccess && config.enabled
      ? new Date(
          lastSuccess.createdAt.getTime() + config.scheduleHours * 60 * 60 * 1000,
        ).toISOString()
      : null;
  return {
    config,
    lastSuccess: lastSuccess
      ? {
          id: lastSuccess.id,
          filename: lastSuccess.filename,
          sizeBytes: lastSuccess.sizeBytes,
          verified: Boolean(lastSuccess.verifiedAt),
          checksum: lastSuccess.checksum?.slice(0, 16) + "…",
          finishedAt: lastSuccess.finishedAt?.toISOString(),
          durationMs: lastSuccess.durationMs,
        }
      : null,
    lastFailed: lastFailed
      ? {
          id: lastFailed.id,
          error: lastFailed.error,
          finishedAt: lastFailed.finishedAt?.toISOString(),
        }
      : null,
    successCount: total,
    pendingCount: pending,
    nextBackup,
    storageDir: "backups/ (encrypted at rest)",
  };
}

/**
 * Verify the LATEST successful backup and record the result.
 * Runs a real AES-256-GCM decryption (auth-tag checked) — see verifyBackup.
 */
export async function verifyLatestBackup(
  triggeredBy?: string,
): Promise<{ ok: boolean; reason?: string; recordId?: string }> {
  const latest = await db.backupRecord.findFirst({
    where: { status: "SUCCESS" },
    orderBy: { createdAt: "desc" },
  });
  if (!latest || !latest.storagePath) return { ok: false, reason: "no_backup" };
  const verdict = await verifyBackup(latest.storagePath, latest.checksum);
  await db.backupRecord.update({
    where: { id: latest.id },
    data: { verifiedAt: verdict.ok ? new Date() : null },
  });
  await logAudit({
    userId: triggeredBy ?? undefined,
    action: verdict.ok ? "BACKUP_VERIFIED" : "BACKUP_VERIFY_FAILED",
    entityType: "backup",
    entityId: latest.id,
    metadata: { reason: verdict.reason ?? "ok" },
  });
  return { ok: verdict.ok, reason: verdict.reason, recordId: latest.id };
}

/** Production safety: never dump raw credentials. */
export function backupEnvHint(): string {
  return isProduction() ? "pg_dump (PostgreSQL)" : "SQLite file copy";
}

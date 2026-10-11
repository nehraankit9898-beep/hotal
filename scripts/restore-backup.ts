/**
 * Backup restore — decrypt a StayLoop backup archive and restore it into a
 * PostgreSQL database (docs/BACKUP_AND_RESTORE.md).
 *
 * SAFETY: restoring is a DESTRUCTIVE operation on the TARGET database.
 * Always restore into a DISPOSABLE/staging database first and verify, then
 * schedule the production cutover (see DEPLOYMENT.md §Rollback).
 *
 * Usage:
 *   INTEGRATION_ENCRYPTION_KEY=<64hex> \
 *   DATABASE_URL=postgresql://stayloop:pass@postgres:5432/stayloop \
 *   bun run scripts/restore-backup.ts \
 *     var/backups/stayloop-backup-2026-01-01T....slbkp.enc \
 *     --target postgresql://stayloop:pass@postgres:5432/stayloop_restore_test
 *
 * The script:
 *   1. Decrypts the archive (AES-256-GCM, auth-tag verified) to a temp dump.
 *   2. pg_restores it into the target database (credentials via environment
 *      variables — never command-line arguments, never printed; the restore
 *      runs in a SINGLE TRANSACTION with --exit-on-error, so a failure leaves
 *      the target database untouched).
 *   3. Reports row counts for the core tables so the operator can eyeball
 *      the restore.
 *   4. Cleans up the temp dump.
 *
 * Exit codes: 0 success, 1 failure (message on stderr).
 */
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import { PrismaClient } from "@prisma/client";
import { decryptArchive, backupDir } from "../src/lib/saas/backup";

const execFileAsync = promisify(execFile);

function arg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

function fail(message: string): never {
  console.error("[restore] " + message);
  process.exit(1);
}

function parsePostgresUrl(url: string) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || "5432",
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ""),
    };
  } catch {
    return null;
  }
}

/** Remove anything that looks like a credential from an error message. */
function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s@/:]+:[^\s@/]+@[^\s]+/g, "[redacted-url]")
    .replace(/\b(password|passphrase|pwd)\s*=\s*\S+/gi, "$1=[redacted]")
    .slice(0, 300);
}

/**
 * AUDIT FIX (restore-1): pg_restore argv. The target URL — which contains the
 * PASSWORD — must NEVER appear on the command line (`ps` exposes argv to
 * every process on the host). pg_restore REQUIRES an explicit -d/--dbname
 * target (unlike psql it does NOT fall back to PGDATABASE), so the BARE
 * database NAME is passed — connection parameters (host/user/password)
 * still come exclusively from PG* environment variables. Verified against a
 * real PostgreSQL 16 pg_restore: omitting --dbname fails with "one of
 * -d/--dbname and -f/--file must be specified".
 *
 * AUDIT FIX (restore-2/3): `--exit-on-error` stops at the FIRST error instead
 * of limping on, and `--single-transaction` wraps the whole restore in ONE
 * transaction — a failed restore leaves the disposable target database
 * UNTOUCHED instead of half-restored (all-or-nothing).
 */
export function pgRestoreArgs(dumpPath: string, databaseName: string): string[] {
  // Defense in depth: the database NAME must be bare — no scheme, no
  // userinfo, no query string (those would reintroduce the argv leak).
  const bare = /^[A-Za-z0-9_-]+$/.test(databaseName)
    ? databaseName
    : databaseName.replace(/[^A-Za-z0-9_-]/g, "_");
  return [
    "--no-password",
    "--exit-on-error",
    "--single-transaction",
    "--clean",
    "--if-exists",
    "--dbname",
    bare, // bare database NAME (never a URL); host/user/password via PG* env
    dumpPath, // input archive (positional)
  ];
}

/**
 * Classify pg_restore stderr. Returns the lines that represent REAL errors
 * (safe to show after sanitization); benign "does not exist, skipping"
 * notes produced by --clean are filtered out. Pure function — unit tested.
 */
export function classifyPgRestoreStderr(stderr: string): {
  realErrors: string[];
  benign: string[];
} {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const realErrors: string[] = [];
  const benign: string[] = [];
  for (const line of lines) {
    if (/does not exist, skipping/i.test(line)) benign.push(line);
    else realErrors.push(line);
  }
  return { realErrors, benign };
}

async function main() {
  const archiveArg = process.argv[2];
  if (!archiveArg || archiveArg.startsWith("--")) {
    fail("Usage: bun run scripts/restore-backup.ts <archive.slbkp.enc> --target <postgresql-url>");
  }
  const targetUrl = arg("--target") ?? process.env.RESTORE_TARGET_URL ?? "";
  if (!targetUrl)
    fail("--target <postgresql-url> is required (restore into a DISPOSABLE database).");

  // Resolve the archive (relative paths resolve against the backup dir).
  const archivePath = path.isAbsolute(archiveArg)
    ? archiveArg
    : path.resolve(backupDir(), archiveArg);
  if (!fs.existsSync(archivePath)) fail(`Archive not found: ${archivePath}`);

  if (!process.env.INTEGRATION_ENCRYPTION_KEY) {
    fail(
      "INTEGRATION_ENCRYPTION_KEY is required to decrypt the archive (or INTEGRATION_ENCRYPTION_PREVIOUS_KEYS for a rotated key).",
    );
  }

  console.log(
    `[restore] archive: ${archivePath} (${(fs.statSync(archivePath).size / 1024).toFixed(1)} KB)`,
  );

  // 1. Decrypt (streaming; auth tag verified — a tampered archive fails here).
  const tmpDump = path.join(os.tmpdir(), `stayloop-restore-${Date.now()}.dump`);
  try {
    await decryptArchive(archivePath, tmpDump);
  } catch (err) {
    fail(`Decryption failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`[restore] decrypted dump: ${tmpDump}`);

  try {
    // 2. pg_restore into the target database — credentials via env only.
    const parsed = parsePostgresUrl(targetUrl);
    if (!parsed || !/^postgres(ql)?:\/\//.test(targetUrl)) {
      fail("--target must be a postgresql:// connection URL.");
    }
    // Forward sslmode from the URL (same behavior as the pg_dump path).
    const sslmode = new URL(targetUrl).searchParams.get("sslmode") ?? "prefer";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PGHOST: parsed.host,
      PGPORT: parsed.port,
      PGUSER: parsed.user,
      PGPASSWORD: parsed.password,
      PGDATABASE: parsed.database,
      PGSSLMODE: sslmode,
    };
    console.log(`[restore] restoring into ${parsed.host}:${parsed.port}/${parsed.database} …`);
    try {
      await execFileAsync("pg_restore", pgRestoreArgs(tmpDump, parsed.database), {
        timeout: 10 * 60 * 1000,
        env,
      });
    } catch (err) {
      // AUDIT FIX (restore-2): the old handler returned the error object as a
      // SUCCESS value whenever stderr was empty or matched the benign pattern
      // — a failed pg_restore (bad credentials, unreachable host, corrupt
      // dump) could be reported as a successful restore. A non-zero exit is
      // now ALWAYS fatal; stderr only shapes the (sanitized) message.
      const execErr = err as {
        stderr?: string;
        stdout?: string;
        code?: number | string;
        killed?: boolean;
      };
      const { realErrors, benign } = classifyPgRestoreStderr(execErr.stderr ?? "");
      void benign;
      const detail =
        realErrors.length > 0
          ? sanitizeErrorMessage(realErrors.join("; "))
          : `pg_restore exited with code ${String(execErr.code ?? "unknown")} without a diagnostic`;
      if (execErr.code === "ENOENT") {
        fail(
          "pg_restore is not installed in this container — the worker/admin image must include postgresql-client (see Dockerfile).",
        );
      }
      fail(`Restore FAILED (target left untouched by --single-transaction): ${detail}`);
    }

    // 3. Verify: connect to the target and count core rows.
    const verify = new PrismaClient({
      datasources: { db: { url: targetUrl } },
    });
    try {
      const [hotels, users, customers, campaigns, messages] = await Promise.all([
        verify.hotel.count(),
        verify.user.count(),
        verify.customer.count(),
        verify.campaign.count(),
        verify.campaignMessage.count(),
      ]);
      console.log("[restore] verification row counts:");
      console.log(`          hotels=${hotels} users=${users} customers=${customers}`);
      console.log(`          campaigns=${campaigns} messages=${messages}`);
      if (users === 0)
        fail(
          "Restored database contains no users — the restore did not apply. Investigate before cutover.",
        );
      console.log(
        "[restore] SUCCESS — verify the data above, then follow the cutover steps in DEPLOYMENT.md.",
      );
    } finally {
      await verify.$disconnect();
    }
  } finally {
    try {
      fs.rmSync(tmpDump, { force: true });
    } catch {
      /* best effort */
    }
  }
}

// Only run when executed directly (bun run scripts/restore-backup.ts …).
// Importing the module (regression tests import pgRestoreArgs /
// classifyPgRestoreStderr) must NOT trigger a restore attempt.
if (import.meta.main) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}

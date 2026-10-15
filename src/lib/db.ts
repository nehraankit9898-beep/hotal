import { PrismaClient } from "@prisma/client";
import path from "path";
import fs from "fs";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * BUGFIX (SQLite path resolution): Prisma CLI resolves a relative `file:` URL
 * (e.g. `file:../db/custom.db`) against the schema directory (`prisma/`), but
 * the Next.js dev/standalone runtime hands the URL to the query engine, which
 * resolves it against the bundled chunk directory — a different base. The
 * result is `Error code 14: Unable to open the database file` on every
 * DB-backed route even though `prisma db push`/`seed` work fine.
 *
 * Fix 1: rewrite RELATIVE SQLite paths to ABSOLUTE paths here so both runtimes
 * agree. Resolution order (documented semantics first):
 *   1. `prisma/` directory (what the Prisma CLI uses; matches .env.example)
 *   2. process CWD (fallback for `file:./dev.db` style values)
 *
 * Fix 2 (dev/test resilience): a `file:` URL that points at a MISSING file —
 * typically a stale absolute path left in the environment after the project
 * was moved/unzipped to a new location — falls back to the shipped demo
 * database (`db/custom.db`) with a loud warning instead of bricking every
 * route with a 500. Production never reaches this branch: the guard below
 * rejects `file:` URLs outright when NODE_ENV=production.
 */
export function resolveSqlitePath(raw: string): string {
  if (!raw.startsWith("file:")) return raw;
  const withoutScheme = raw.slice("file:".length);
  const queryStart = withoutScheme.indexOf("?");
  const query = queryStart >= 0 ? withoutScheme.slice(queryStart) : "";
  let filePath = queryStart >= 0 ? withoutScheme.slice(0, queryStart) : withoutScheme;
  if (filePath && !path.isAbsolute(filePath)) {
    const candidates = [
      path.resolve(process.cwd(), "prisma", filePath), // documented: relative to prisma/
      path.resolve(process.cwd(), filePath), // CWD-relative fallback
    ];
    // The existence probes are marked with `/* turbopackIgnore: true */` so
    // production builds do not trace the whole project through these dynamic
    // filesystem accesses (Turbopack warning in src/lib/db.ts). Behaviour is
    // unchanged: results are still computed at runtime.
    filePath = candidates.find((c) => fs.existsSync(/* turbopackIgnore: true */ c)) ?? candidates[0];
  }

  if (filePath && !fs.existsSync(/* turbopackIgnore: true */ filePath)) {
    const demoDb = path.resolve(process.cwd(), "db", "custom.db");
    if (process.env.NODE_ENV !== "production" && fs.existsSync(/* turbopackIgnore: true */ demoDb)) {
      warnMissingDbOnce(filePath, demoDb);
      return `file:${demoDb}${query}`;
    }
  }
  return `file:${filePath}${query}`;
}

/** Log the stale-DATABASE_URL warning at most once per process. */
let missingDbWarned = false;
function warnMissingDbOnce(missingPath: string, demoDb: string): void {
  if (missingDbWarned) return;
  missingDbWarned = true;
  console.warn(
    `[stayloop] DATABASE_URL points to a missing SQLite file (${missingPath}). ` +
      `Falling back to the shipped demo database (${demoDb}). ` +
      "Update or unset DATABASE_URL to use a different database.",
  );
}

/**
 * Prisma client singleton.
 * - Phase 20: query logging is off by default (PII must not land in logs);
 *   enable temporarily with LOG_PRISMA_QUERIES=1.
 * - Phase 13: the connection pool is sized explicitly so concurrent
 *   interactive transactions (coupon redemption slot reservations) queue on
 *   the pool instead of failing with connection-fetch timeouts.
 */
function datasourceUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  const resolved = resolveSqlitePath(raw);
  if (!resolved.startsWith("file:")) return resolved;
  // SQLite (dev/test): a single connection per process eliminates
  // SQLITE_BUSY storms between pooled writers, and a long socket timeout
  // keeps cross-process lock contention from surfacing as P1008 errors.
  // Queries are millisecond-level, so strict queueing is imperceptible.
  // NOTE: the pool params must be appended to EVERY file: URL (resolved or
  // not) — skipping them for already-absolute URLs silently re-enables the
  // multi-connection pool and brings back SQLITE_BUSY / P1008 timeouts under
  // concurrent writes (regression caught by the Phase 6.4 concurrency suite).
  const sep = resolved.includes("?") ? "&" : "?";
  return `${resolved}${sep}connection_limit=1&pool_timeout=60&socket_timeout=60`;
}

// Phase 6.4 (spec §10) — production MUST run on PostgreSQL. A file: (SQLite)
// DATABASE_URL in production is a misconfiguration: fail fast instead of
// silently falling back to a dev database.
// Phase 7: the guard skips the BUILD phase (NEXT_PHASE=phase-production-build,
// where .env holds the dev SQLite file and no server runs) but still fails
// fast at production STARTUP — the standalone server refuses to boot.
const isNextBuildPhase = process.env.NEXT_PHASE === "phase-production-build";
if (
  process.env.NODE_ENV === "production" &&
  !isNextBuildPhase &&
  process.env.DATABASE_URL?.startsWith("file:")
) {
  throw new Error(
    "Invalid production configuration: DATABASE_URL points to SQLite (file:). " +
      "Set DATABASE_URL to a PostgreSQL connection string (see prisma/schema.postgres.prisma).",
  );
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.LOG_PRISMA_QUERIES === "1" ? ["query"] : ["error"],
    datasources: (() => {
      const url = datasourceUrl();
      return url ? { db: { url } } : undefined;
    })(),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

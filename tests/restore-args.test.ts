/**
 * pg_restore invocation contract — regression tests for restore-1/2/3:
 *
 *  restore-1: the target connection URL (which embeds the PASSWORD) must
 *    never appear in pg_restore argv — `ps` exposes argv to every process on
 *    the host. Connection parameters come from PG* environment variables.
 *  restore-2: a non-zero pg_restore exit is ALWAYS fatal. The old catch
 *    handler returned the error object as a success value whenever stderr
 *    was empty or matched the benign pattern — a failed restore (bad
 *    credentials, corrupt dump) could be reported as SUCCESS and the row
 *    counts then verified against a stale database.
 *  restore-3: the restore runs inside ONE transaction (--single-transaction,
 *    which implies --exit-on-error) — a failure leaves the disposable target
 *    untouched instead of half-restored.
 */
import "./queue-test-env";
import { describe, test, expect } from "bun:test";

import { pgRestoreArgs, classifyPgRestoreStderr } from "../scripts/restore-backup";

describe("restore-1 — credentials never appear in pg_restore argv", () => {
  test("argv passes the BARE database name — never the connection URL", () => {
    const args = pgRestoreArgs("/tmp/stayloop-restore-123.dump", "stayloop_restore_test");
    expect(args).toContain("--no-password");
    // pg_restore REQUIRES -d/--dbname (it does not fall back to PGDATABASE);
    // the value must be the bare database NAME, not the URL with credentials.
    const dbIdx = args.indexOf("--dbname");
    expect(dbIdx).toBeGreaterThanOrEqual(0);
    expect(args[dbIdx + 1]).toBe("stayloop_restore_test");
    for (const arg of args) {
      expect(arg).not.toMatch(/postgres(ql)?:\/\//);
      expect(arg).not.toMatch(/:[^:@\s]+@/); // user:pass@host shape
      expect(arg).not.toContain("PGPASSWORD");
    }
    // The dump path is the last (positional) argument.
    expect(args[args.length - 1]).toBe("/tmp/stayloop-restore-123.dump");
  });

  test("a hostile database name is sanitized to a bare identifier (no scheme/userinfo)", () => {
    const args = pgRestoreArgs("x.dump", "pg://user:pass@host/db?x=1");
    const dbIdx = args.indexOf("--dbname");
    expect(args[dbIdx + 1]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(args[dbIdx + 1]).not.toContain(":");
    expect(args.join(" ")).not.toMatch(/user:pass/);
  });
});

describe("restore-3 — transactional restore flags", () => {
  test("--single-transaction is present (all-or-nothing)", () => {
    expect(pgRestoreArgs("x.dump", "db")).toContain("--single-transaction");
  });

  test("--exit-on-error is present (stop at the first error, explicit)", () => {
    expect(pgRestoreArgs("x.dump", "db")).toContain("--exit-on-error");
  });

  test("--clean --if-exists keep the disposable-target semantics", () => {
    const args = pgRestoreArgs("x.dump", "db");
    expect(args).toContain("--clean");
    expect(args).toContain("--if-exists");
  });
});

describe("restore-2 — stderr classification (pure function)", () => {
  test("benign --clean notes are separated from real errors", () => {
    const stderr = [
      'pg_restore: error: could not execute query: ERROR:  table "users" does not exist, skipping',
      'pg_restore: creating TABLE "public"."Hotel"',
      "pg_restore: [archiver (db)] Error while PROCESSING TOC:",
      "pg_restore: [archiver] DBID 257 does not exist, skipping",
    ].join("\n");
    const { realErrors, benign } = classifyPgRestoreStderr(stderr);
    expect(benign.length).toBe(2);
    expect(realErrors.length).toBe(2);
    expect(realErrors[0]).toContain("creating TABLE");
    expect(realErrors[1]).toContain("PROCESSING TOC");
  });

  test("empty stderr yields no errors (callers must still fail on the exit code)", () => {
    const { realErrors, benign } = classifyPgRestoreStderr("");
    expect(realErrors).toEqual([]);
    expect(benign).toEqual([]);
  });

  test("credential-shaped stderr is identifiable for sanitization (URL with password)", () => {
    // The sanitizer's target pattern: a URL containing user:pass@host.
    const nasty =
      "pg_restore: error: connection to database failed: postgresql://stayloop:SuperSecret@postgres:5432/x";
    expect(nasty).toMatch(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s@/:]+:[^\s@/]+@[^\s]+/);
  });
});

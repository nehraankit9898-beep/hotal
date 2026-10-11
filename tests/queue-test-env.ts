/**
 * Queue-test environment — MUST be the first import of
 * tests/queue-reliability.test.ts. Import statements are hoisted and execute
 * in declaration order, so setting the env HERE guarantees the app's db
 * singleton (imported transitively by src/lib/queue.ts) resolves to the
 * throwaway test database instead of whatever the shell had.
 */
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

(process.env as Record<string, string | undefined>).NODE_ENV = "test";
process.env.STAYLOOP_TEST = "1";

const tmp = mkdtempSync(join(tmpdir(), "stayloop-queue-test-"));
const dbPath = join(tmp, "queue.db");
// Pre-create an empty file: a zero-byte file is a valid empty SQLite database.
// Without this, src/lib/db.ts treats the URL as "missing file" and falls back
// to the shipped demo DB (dev-only resilience) — the tests would then run
// against the wrong database.
writeFileSync(dbPath, "", { mode: 0o600 });
process.env.DATABASE_URL = `file:${dbPath}`;

/** Cleanup handle for afterAll. */
export const QUEUE_TEST_TMP = tmp;

export function cleanupQueueTestTmp(): void {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

import fs from "fs";
import { db } from "@/lib/db";

/**
 * Worker heartbeat — Phase 10 production observability.
 *
 * The standalone worker writes a heartbeat row every HEARTBEAT_INTERVAL_MS so
 * the web readiness endpoint (/api/health) can report whether a worker is
 * actually making progress ("observable worker heartbeat, not just
 * process-exists checks"). Two channels:
 *
 *  1. DATABASE row (PlatformSetting key "worker.heartbeat") — visible to the
 *     web containers through the shared PostgreSQL instance.
 *  2. LOCAL file (/tmp/worker-heartbeat.json) — used by the worker container's
 *     own Docker healthcheck (no cross-container dependency).
 *
 * The stored value NEVER contains secrets — just worker id + timestamp.
 */

export const WORKER_HEARTBEAT_KEY = "worker.heartbeat";

export interface WorkerHeartbeatValue {
  workerId: string;
  at: number; // epoch ms
  pid: number;
  /** Jobs completed since process start (monotonic counter). */
  jobsCompleted: number;
}

/** Write the heartbeat row (best-effort — never throws into the job loop). */
export async function setWorkerHeartbeat(value: WorkerHeartbeatValue): Promise<void> {
  try {
    await db.platformSetting.upsert({
      where: { key: WORKER_HEARTBEAT_KEY },
      create: { key: WORKER_HEARTBEAT_KEY, value: JSON.stringify(value) },
      update: { value: JSON.stringify(value) },
    });
  } catch {
    /* transient DB errors must not kill the worker */
  }
}

export type WorkerHeartbeatStatus = "ok" | "stale" | "unknown";

/**
 * Age-based worker heartbeat status for /api/health.
 *  - "ok":      fresh heartbeat within STALE_AFTER_MS
 *  - "stale":   a heartbeat EXISTS but is older than STALE_AFTER_MS
 *               → the worker died or is wedged → readiness fails
 *  - "unknown": no heartbeat row at all (fresh deployment before the worker's
 *               first tick) → readiness does NOT fail; documented so a missing
 *               worker can be detected via /api/super-admin/health + logs.
 */
export async function workerHeartbeatStatus(
  staleAfterMs = 3 * 60 * 1000,
): Promise<WorkerHeartbeatStatus> {
  try {
    const row = await db.platformSetting.findUnique({ where: { key: WORKER_HEARTBEAT_KEY } });
    if (!row) return "unknown";
    const parsed = JSON.parse(row.value) as Partial<WorkerHeartbeatValue>;
    if (typeof parsed.at !== "number") return "unknown";
    return Date.now() - parsed.at <= staleAfterMs ? "ok" : "stale";
  } catch {
    // DB errors are surfaced by the database check itself.
    return "unknown";
  }
}

/** Local-file heartbeat path used by the worker container healthcheck. */
export const WORKER_HEARTBEAT_FILE = "/tmp/worker-heartbeat.json";

/** Write the local file heartbeat (best-effort). */
export function writeLocalHeartbeat(value: WorkerHeartbeatValue): void {
  try {
    fs.writeFileSync(WORKER_HEARTBEAT_FILE, JSON.stringify(value) + "\n", { mode: 0o600 });
  } catch {
    /* never throw from heartbeat paths */
  }
}

/** Read the local file heartbeat age in ms (null when absent/unreadable). */
export function localHeartbeatAgeMs(): number | null {
  try {
    const raw = fs.readFileSync(WORKER_HEARTBEAT_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkerHeartbeatValue>;
    if (typeof parsed.at !== "number") return null;
    return Date.now() - parsed.at;
  } catch {
    return null;
  }
}

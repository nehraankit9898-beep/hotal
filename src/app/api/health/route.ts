import { db } from "@/lib/db";
import { queueDepth } from "@/lib/queue";
import { redisHealthProbe, distributedLimiterStatus, slidingWindow } from "@/lib/rate-limit";
import { emailTransportStatus } from "@/lib/providers/email";
import { workerHeartbeatStatus } from "@/lib/worker-heartbeat";
import { requireEmailVerification } from "@/lib/env";
import { isProduction } from "@/lib/config";

/**
 * GET /api/health — READINESS probe (Phase 7 spec §30, §50; audit fix: the
 * old implementation reported ready whenever the DATABASE answered, even
 * when queue checks failed and required dependencies were down).
 *
 * Semantics:
 *   200 → ready — the instance may serve traffic
 *   503 → NOT ready — remove this instance from rotation (fail closed)
 *
 * Readiness requirements (per enabled configuration):
 *   - database: MUST be reachable (always required)
 *   - queue:    background jobs live in the DB — MUST be countable
 *   - redis:    required ONLY when REDIS_URL is configured (shared rate
 *               limiting); a real PING with a short timeout
 *   - email:    required ONLY when REQUIRE_EMAIL_VERIFICATION=true (or any
 *               email provider is configured in production) — must resolve to
 *               a REAL provider (smtp/aws_ses/resend/sendgrid). The mock is
 *               dev/test only and never satisfies production readiness.
 *   - worker:   observable heartbeat (not a process-exists check).
 *               "stale" (a heartbeat exists but stopped) → NOT ready.
 *               "unknown" (no heartbeat yet, e.g. first boot before the
 *               worker's first tick) → reported but NOT failing — detect a
 *               missing worker via /api/super-admin/health + logs.
 *
 * Unauthenticated but deliberately LOW-INFORMATION: booleans and enum states
 * only — no counts, no provider values, no internal paths. Detailed
 * (super-admin-only) diagnostics live at /api/super-admin/health.
 * Liveness (process alive, no dependency checks) lives at /api/health/live.
 */
export async function GET(req: Request) {
  // Public endpoint abuse protection: cheap in-process damping (no DB/Redis
  // dependency in the limiter itself). 300/15min absorbs multiple monitors
  // (e.g. 4 probes at 10s intervals) while blunting scraping; responses stay
  // low-information booleans either way.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    "unknown";
  const burst = slidingWindow(`health:${ip}`, 300, 15 * 60 * 1000);
  if (!burst.allowed) {
    return Response.json(
      { status: "unavailable" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": String(burst.retryAfterSeconds) },
      },
    );
  }

  const checks: Record<string, unknown> = {};

  // Database (always required)
  let dbOk = false;
  try {
    await db.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }
  checks.database = dbOk ? "ok" : "error";

  // Queue (background jobs live in the DB — counts must be answerable)
  let queueOk = false;
  if (dbOk) {
    try {
      await queueDepth();
      queueOk = true;
    } catch {
      queueOk = false;
    }
  }
  checks.queue = queueOk ? "ok" : "error";

  // Redis — required only when configured (active PING probe)
  const redisStatus = await redisHealthProbe();
  checks.redis = redisStatus;
  checks.rateLimiter = distributedLimiterStatus(); // last-operation status (info only)
  const redisRequired = redisStatus !== "disabled"; // disabled = per-instance fallback (documented)

  // Email — required when verification flows depend on it, or when any
  // provider is configured in production; must be a REAL transport.
  const transport = emailTransportStatus();
  checks.email = transport;
  const realTransports = new Set(["smtp", "aws_ses", "resend", "sendgrid"]);
  const emailConfigured =
    Boolean(process.env.SMTP_URL?.trim()) ||
    Boolean(process.env.RESEND_API_KEY?.trim()) ||
    Boolean(process.env.SENDGRID_API_KEY?.trim());
  const emailRequired = requireEmailVerification() || (isProduction() && emailConfigured);
  const emailOk = !emailRequired || (realTransports.has(transport) && transport !== "unconfigured");

  // Worker heartbeat — observable liveness of the background worker
  const workerStatus = dbOk ? await workerHeartbeatStatus() : "unknown";
  checks.worker = workerStatus;
  const workerOk = workerStatus !== "stale";

  const ready =
    dbOk && queueOk && (!redisRequired || redisStatus === "ready") && emailOk && workerOk;
  return Response.json(
    {
      status: ready ? "ok" : "unavailable",
      checks,
    },
    {
      status: ready ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export const dynamic = "force-dynamic";

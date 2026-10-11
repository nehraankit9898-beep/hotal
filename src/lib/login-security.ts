import { db } from "@/lib/db";
import { clientIp } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { logSecurityEvent } from "@/lib/saas/security";

/**
 * Login security — Phase 10.
 *
 * Authoritative, DB-backed (shared across processes/instances):
 *   - per-account lockout via User.failedLoginAttempts / lockedUntil
 *   - progressive lockout: 15 min → 30 min → 60 min → 24 h
 *   - per-IP throttling via the AuthAttempt table
 *   - every attempt recorded (AuthAttempt + AuditLog with IP)
 *
 * The in-process sliding-window limiter is used as an additional cheap
 * damping layer, never as the sole control.
 */

const MAX_FAILURES = 5;
const LOCK_STEPS_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000, 24 * 60 * 60_000];
const IP_WINDOW_MS = 15 * 60_000;
// Volume cap: protects against enumeration bursts while staying friendly to
// shared/NAT offices where many legitimate users sign in from one IP.
// Failure-driven throttling (below) remains the primary brute-force control.
const IP_MAX_ATTEMPTS = 200;
const IP_MAX_FAILURES = 25;

export interface LockoutStatus {
  locked: boolean;
  retryAfterSeconds?: number;
  lockLevel?: number;
}

/** Is the account currently locked? */
export async function getLockoutStatus(userId: string): Promise<LockoutStatus> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { lockedUntil: true, failedLoginAttempts: true },
  });
  if (!user?.lockedUntil) return { locked: false };
  if (user.lockedUntil > new Date()) {
    return {
      locked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000)),
      lockLevel: Math.floor((user.failedLoginAttempts || 0) / MAX_FAILURES),
    };
  }
  return { locked: false };
}

/** Per-IP throttling from the shared AuthAttempt table. */
export async function isIpThrottled(
  ip: string,
): Promise<{ throttled: boolean; reason?: "volume" | "failures" }> {
  if (ip === "unknown") return { throttled: false };
  const since = new Date(Date.now() - IP_WINDOW_MS);
  const [total, failures] = await Promise.all([
    db.authAttempt.count({ where: { ipAddress: ip, createdAt: { gte: since } } }),
    db.authAttempt.count({ where: { ipAddress: ip, success: false, createdAt: { gte: since } } }),
  ]);
  if (failures >= IP_MAX_FAILURES) return { throttled: true, reason: "failures" };
  if (total >= IP_MAX_ATTEMPTS) return { throttled: true, reason: "volume" };
  return { throttled: false };
}

export interface FailureRecordResult {
  justLocked: boolean;
  lockedForSeconds?: number;
}

/** Record a failed attempt for the account (creates lockout when threshold hit). */
export async function recordFailedLogin(params: {
  userId: string;
  email: string;
  ip: string;
  hotelId?: string | null;
}): Promise<FailureRecordResult> {
  // Phase 10 — Security Centre feed.
  await logSecurityEvent({
    type: "FAILED_LOGIN",
    severity: "WARNING",
    userId: params.userId,
    email: params.email,
    hotelId: params.hotelId ?? null,
    ipAddress: params.ip,
    details: { email: params.email },
  });
  // SECURITY FIX (lost update): the counter is incremented atomically in SQL
  // and the NEW value is read back from the same statement's result. The old
  // read-then-write let parallel wrong guesses all read the same value, so
  // the 5-attempt lockout could be bypassed with concurrent requests.
  const bumped = await db.user.update({
    where: { id: params.userId },
    data: { failedLoginAttempts: { increment: 1 } },
    select: { failedLoginAttempts: true },
  });
  const failures = bumped.failedLoginAttempts;
  const lockIndex = Math.floor(failures / MAX_FAILURES) - 1; // 0-based on each 5th
  const justLocked = failures % MAX_FAILURES === 0 && lockIndex >= 0;
  const lockedForSeconds = justLocked
    ? Math.floor(LOCK_STEPS_MS[Math.min(lockIndex, LOCK_STEPS_MS.length - 1)] / 1000)
    : undefined;

  if (justLocked) {
    await db.user.update({
      where: { id: params.userId },
      data: { lockedUntil: new Date(Date.now() + (lockedForSeconds ?? 0) * 1000) },
    });
  }

  await recordAuthAttempt({ email: params.email, success: false, ip: params.ip });

  await logAudit({
    hotelId: params.hotelId ?? null,
    userId: params.userId,
    action: "LOGIN_FAILED",
    entityType: "user",
    entityId: params.userId,
    metadata: {
      failures,
      locked: justLocked,
      lockMinutes: lockedForSeconds ? Math.floor(lockedForSeconds / 60) : null,
    },
    ipAddress: params.ip,
  });

  if (justLocked) {
    await logSecurityEvent({
      type: "LOCKOUT",
      severity: "CRITICAL",
      userId: params.userId,
      email: params.email,
      hotelId: params.hotelId ?? null,
      ipAddress: params.ip,
      details: { failures, lockedForSeconds },
    });
  }

  return { justLocked, lockedForSeconds };
}

/** Record a successful login: clear counters, stamp lastLogin*. */
export async function recordSuccessfulLogin(params: {
  userId: string;
  email: string;
  ip: string;
  hotelId?: string | null;
}): Promise<void> {
  await db.user.update({
    where: { id: params.userId },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: params.ip,
    },
  });
  await recordAuthAttempt({ email: params.email, success: true, ip: params.ip });
}

/**
 * Persist one attempt for the shared per-IP throttle. Used for BOTH known and
 * unknown accounts: previously unknown-email failures were never counted, so
 * an attacker could probe arbitrary addresses without touching the IP limit.
 */
export async function recordAuthAttempt(params: {
  email: string;
  success: boolean;
  ip: string;
}): Promise<void> {
  await db.authAttempt.create({
    data: {
      email: params.email.toLowerCase(),
      success: params.success,
      ipAddress: params.ip === "unknown" ? null : params.ip,
    },
  });
}

/**
 * Housekeeping: AuthAttempt rows older than the throttle window are never read
 * again. Deleting them keeps the table (and the per-login IP count) small.
 */
export async function purgeOldAuthAttempts(olderThanMs = 7 * 24 * 60 * 60_000): Promise<number> {
  const res = await db.authAttempt.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - olderThanMs) } },
  });
  return res.count;
}

/** Shared request-context helper. */
export function requestIp(req: Request): string {
  return clientIp(req);
}

export const LOGIN_LIMITS = { MAX_FAILURES, IP_MAX_ATTEMPTS, IP_MAX_FAILURES, IP_WINDOW_MS };

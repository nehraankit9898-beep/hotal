import { db } from "@/lib/db";

/**
 * Security Centre feed — Phase 10 §13.
 *
 * Structured security events (failed logins, lockouts, rate-limit hits,
 * CSRF blocks, session revocations, MFA changes, suspicious activity) that
 * feed the Super Admin Security dashboard. Written via logSecurityEvent()
 * from the relevant guards — never throws into the request path.
 */

export type SecurityEventType =
  | "FAILED_LOGIN"
  | "LOCKOUT"
  | "IP_THROTTLED"
  | "RATE_LIMITED"
  | "CSRF_BLOCKED"
  | "SUSPICIOUS_ACTIVITY"
  | "SESSION_REVOKED"
  | "FORCE_LOGOUT"
  | "MFA_CHALLENGE_FAILED"
  | "MFA_DISABLED"
  | "MFA_POLICY_ENFORCED"
  | "IP_BLOCKED"
  | "IP_UNBLOCKED"
  | "TENANT_BLOCKED"
  | "WEBHOOK_REJECTED"
  | "WEBHOOK_ANOMALY"
  | "PERMISSION_DENIED";

export type SecuritySeverity = "INFO" | "WARNING" | "CRITICAL";

export async function logSecurityEvent(event: {
  type: SecurityEventType;
  severity?: SecuritySeverity;
  userId?: string | null;
  email?: string | null;
  hotelId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.securityEvent.create({
      data: {
        type: event.type,
        severity: event.severity ?? "INFO",
        userId: event.userId ?? null,
        email: event.email ?? null,
        hotelId: event.hotelId ?? null,
        ipAddress: event.ipAddress ?? null,
        userAgent: event.userAgent?.slice(0, 300) ?? null,
        details: event.details ? JSON.stringify(event.details).slice(0, 2000) : null,
      },
    });
  } catch (err) {
    console.error("[security-event] failed to write:", err instanceof Error ? err.message : err);
  }
}

/** Security dashboard aggregates for the Super Admin UI. */
export async function getSecurityOverview() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [
    failedLogins24h,
    lockouts24h,
    rateLimited24h,
    csrfBlocked24h,
    suspicious24h,
    mfaDisabled7d,
    sessionRevoked7d,
    unreviewedCritical,
    recentEvents,
    mfaEnabledUsers,
    totalUsers,
  ] = await Promise.all([
    db.securityEvent.count({ where: { type: "FAILED_LOGIN", createdAt: { gte: since } } }),
    db.securityEvent.count({ where: { type: "LOCKOUT", createdAt: { gte: since } } }),
    db.securityEvent.count({ where: { type: "RATE_LIMITED", createdAt: { gte: since } } }),
    db.securityEvent.count({ where: { type: "CSRF_BLOCKED", createdAt: { gte: since } } }),
    db.securityEvent.count({ where: { type: "SUSPICIOUS_ACTIVITY", createdAt: { gte: since } } }),
    db.securityEvent.count({ where: { type: "MFA_DISABLED", createdAt: { gte: week } } }),
    db.securityEvent.count({ where: { type: "SESSION_REVOKED", createdAt: { gte: week } } }),
    db.securityEvent.count({ where: { severity: "CRITICAL", reviewedAt: null } }),
    db.securityEvent.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    db.user.count({ where: { mfaEnabled: true } }),
    db.user.count(),
  ]);

  return {
    failedLogins24h,
    lockouts24h,
    rateLimited24h,
    csrfBlocked24h,
    suspicious24h,
    mfaDisabled7d,
    sessionRevoked7d,
    unreviewedCritical,
    mfaAdoption: totalUsers > 0 ? Math.round((mfaEnabledUsers / totalUsers) * 100) : 0,
    recentEvents: recentEvents.map((e) => ({
      id: e.id,
      type: e.type,
      severity: e.severity,
      email: e.email,
      hotelId: e.hotelId,
      ipAddress: e.ipAddress,
      details: e.details,
      reviewedAt: e.reviewedAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

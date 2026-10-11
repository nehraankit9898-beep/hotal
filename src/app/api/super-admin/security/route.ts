import { NextResponse } from "next/server";
import { readJson, jsonError, serverError, requireSuperAdminSession } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { getSecurityOverview, logSecurityEvent } from "@/lib/saas/security";
import { getSetting, setSetting } from "@/lib/saas/settings";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

/**
 * Security Centre — Phase 9 §12 + Phase 10 §13 (Super Admin only).
 *   GET  /api/super-admin/security    → dashboard aggregates + MFA policy
 *   POST /api/super-admin/security    → actions:
 *        block-ip / unblock-ip / force-logout / review-event / suspend-user
 * Force-logout bumps tokenVersion (revokes EVERY issued session instantly).
 */
export async function GET(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const [overview, mfaPolicy, securitySettings] = await Promise.all([
      getSecurityOverview(),
      getSetting("mfa.policy"),
      getSetting("security"),
    ]);
    return NextResponse.json({ overview, mfaPolicy, securitySettings });
  } catch (err) {
    return serverError(err, "Could not load the security dashboard.");
  }
}

export async function POST(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const body = await readJson(req);
    const action = typeof body?.action === "string" ? body.action : "";
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";

    switch (action) {
      case "block-ip": {
        const ip = typeof body?.ip === "string" ? body.ip.trim() : "";
        if (!/^[0-9a-fA-F.:]{3,45}$/.test(ip))
          return jsonError("Invalid IP address.", 422, "VALIDATION_ERROR");
        if (reason.length < 3)
          return jsonError("A reason is required to block an IP.", 422, "REASON_REQUIRED");
        const security = await getSetting("security");
        if (security.blockedIps.includes(ip))
          return jsonError("IP is already blocked.", 409, "CONFLICT");
        security.blockedIps.push(ip);
        await setSetting("security", security, { userId: guard.session.userId, req });
        await logSecurityEvent({
          type: "IP_BLOCKED",
          severity: "WARNING",
          ipAddress: ip,
          userId: guard.session.userId,
          details: { reason },
        });
        await logAudit({
          userId: guard.session.userId,
          action: AUDIT_ACTIONS.IP_BLOCKED,
          entityType: "ip",
          entityId: ip,
          metadata: { reason },
          req,
        });
        return NextResponse.json({ ok: true, blockedIps: security.blockedIps });
      }
      case "unblock-ip": {
        const ip = typeof body?.ip === "string" ? body.ip.trim() : "";
        const security = await getSetting("security");
        security.blockedIps = security.blockedIps.filter((i) => i !== ip);
        await setSetting("security", security, { userId: guard.session.userId, req });
        await logSecurityEvent({
          type: "IP_UNBLOCKED",
          severity: "INFO",
          ipAddress: ip,
          userId: guard.session.userId,
        });
        await logAudit({
          userId: guard.session.userId,
          action: AUDIT_ACTIONS.IP_UNBLOCKED,
          entityType: "ip",
          entityId: ip,
          req,
        });
        return NextResponse.json({ ok: true, blockedIps: security.blockedIps });
      }
      case "force-logout": {
        const userId = typeof body?.userId === "string" ? body.userId : "";
        if (!userId) return jsonError("userId is required.", 422, "VALIDATION_ERROR");
        if (reason.length < 3)
          return jsonError("A reason is required to force a logout.", 422, "REASON_REQUIRED");
        const user = await db.user.findUnique({ where: { id: userId } });
        if (!user) return jsonError("User not found.", 404, "NOT_FOUND");
        if (user.id === guard.session.userId)
          return jsonError("You cannot force-logout your own session.", 400, "BAD_REQUEST");
        await db.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
        await logSecurityEvent({
          type: "FORCE_LOGOUT",
          severity: "WARNING",
          userId,
          email: user.email,
          hotelId: user.hotelId,
          details: { reason },
        });
        await logAudit({
          hotelId: user.hotelId,
          userId: guard.session.userId,
          action: AUDIT_ACTIONS.FORCE_LOGOUT,
          entityType: "user",
          entityId: userId,
          metadata: { target: user.email, reason },
        });
        return NextResponse.json({ ok: true });
      }
      case "suspend-user": {
        const userId = typeof body?.userId === "string" ? body.userId : "";
        if (!userId) return jsonError("userId is required.", 422, "VALIDATION_ERROR");
        if (reason.length < 3)
          return jsonError("A reason is required to suspend an account.", 422, "REASON_REQUIRED");
        const user = await db.user.findUnique({ where: { id: userId } });
        if (!user) return jsonError("User not found.", 404, "NOT_FOUND");
        if (user.role === "SUPER_ADMIN")
          return jsonError("Suspend super admins via bootstrap policy instead.", 403, "FORBIDDEN");
        await db.user.update({
          where: { id: userId },
          data: { status: "SUSPENDED", tokenVersion: { increment: 1 } },
        });
        await logSecurityEvent({
          type: "SUSPICIOUS_ACTIVITY",
          severity: "CRITICAL",
          userId,
          email: user.email,
          hotelId: user.hotelId,
          details: { action: "account-suspended", reason },
        });
        await logAudit({
          hotelId: user.hotelId,
          userId: guard.session.userId,
          action: AUDIT_ACTIONS.USER_SUSPENDED,
          entityType: "user",
          entityId: userId,
          metadata: { target: user.email, reason },
        });
        return NextResponse.json({ ok: true });
      }
      case "review-event": {
        const eventId = typeof body?.eventId === "string" ? body.eventId : "";
        if (!eventId) return jsonError("eventId is required.", 422, "VALIDATION_ERROR");
        const event = await db.securityEvent.findUnique({ where: { id: eventId } });
        if (!event) return jsonError("Security event not found.", 404, "NOT_FOUND");
        await db.securityEvent.update({
          where: { id: eventId },
          data: { reviewedAt: new Date(), reviewedBy: guard.session.userId },
        });
        await logAudit({
          userId: guard.session.userId,
          action: AUDIT_ACTIONS.SECURITY_EVENT_REVIEWED,
          entityType: "security_event",
          entityId: eventId,
          req,
        });
        return NextResponse.json({ ok: true });
      }
      default:
        return jsonError("Unknown security action.", 422, "VALIDATION_ERROR");
    }
  } catch (err) {
    return serverError(err, "Could not perform the security action.");
  }
}

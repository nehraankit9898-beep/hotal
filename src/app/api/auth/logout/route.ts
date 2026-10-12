import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionAuth, SESSION_COOKIE, clearSessionCookieOptions, CSRF_COOKIE } from "@/lib/auth";
import { assertCsrf } from "@/lib/csrf";
import { jsonError } from "@/lib/api-helpers";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { requestIp } from "@/lib/login-security";

/**
 * POST /api/auth/logout — revoke the current session.
 * Phase 9: the session token is invalidated server-side by bumping the user's
 * tokenVersion (all tokens for the user become unusable), not merely by
 * clearing the cookie. Applies to both cookie and Bearer sessions.
 */
export async function POST(req: Request) {
  // AUDIT FIX (SEC-006): logout is state-changing (bumps tokenVersion, revoking every
  // session of the user). Session cookies are SameSite=None in production, so without
  // this check a cross-site page could force-logout any signed-in user (logout CSRF).
  const info = getSessionAuth(req);
  const csrf = assertCsrf(req, {
    bearerSession: info?.via === "bearer",
    hasCookieSession: info?.via === "cookie",
  });
  if (!csrf.ok && csrf.status && csrf.code) {
    return jsonError(csrf.message ?? "Request blocked.", csrf.status, csrf.code);
  }
  const session = info?.session ?? null;
  if (session) {
    try {
      await db.user.update({
        where: { id: session.userId },
        data: { tokenVersion: { increment: 1 } },
      });
    } catch {
      // Revocation failure must not prevent the cookie from being cleared.
    }
    await logAudit({
      req,
      hotelId: session.hotelId || null,
      userId: session.userId,
      action: AUDIT_ACTIONS.LOGOUT,
      entityType: "user",
      entityId: session.userId,
      ipAddress: requestIp(req),
    });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", clearSessionCookieOptions(req));
  res.cookies.set(CSRF_COOKIE, "", { ...clearSessionCookieOptions(req), httpOnly: false });
  return res;
}

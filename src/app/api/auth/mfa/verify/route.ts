import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { generateCsrfToken, CSRF_COOKIE, csrfCookieOptions } from "@/lib/csrf";
import { jsonError, readJson, serverError } from "@/lib/api-helpers";
import { verifyMfaPendingToken, verifyLoginCode } from "@/lib/mfa";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import {
  recordSuccessfulLogin,
  requestIp,
  getLockoutStatus,
  recordFailedLogin,
} from "@/lib/login-security";
import { checkRateLimit } from "@/lib/rate-limit";
import { logSecurityEvent } from "@/lib/saas/security";

/**
 * POST /api/auth/mfa/verify — Phase 10 §14.
 * Completes a login that stopped at the MFA challenge:
 *   { mfaToken, code }  → full session (cookie + bearer fallback)
 * The pending token is short-lived, single-purpose and NEVER grants API
 * access by itself. Failed attempts are rate-limited + audited.
 */
export async function POST(req: Request) {
  try {
    const ip = requestIp(req);
    const burst = await checkRateLimit(`mfa-verify:${ip}`, 30, 5 * 60 * 1000);
    if (!burst.allowed) {
      await logSecurityEvent({
        type: "RATE_LIMITED",
        severity: "WARNING",
        ipAddress: ip,
        details: { scope: "mfa-verify" },
      });
      return jsonError(
        `Too many attempts. Please wait ${burst.retryAfterSeconds} seconds and try again.`,
        429,
        "RATE_LIMITED",
      );
    }

    const body = await readJson(req);
    const mfaToken = typeof body?.mfaToken === "string" ? body.mfaToken : "";
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!mfaToken || !code) {
      return jsonError("An authentication code is required.", 422, "VALIDATION_ERROR");
    }

    const userId = verifyMfaPendingToken(mfaToken);
    if (!userId) {
      return jsonError(
        "Your challenge has expired. Please sign in again.",
        401,
        "MFA_CHALLENGE_EXPIRED",
      );
    }

    const user = await db.user.findUnique({ where: { id: userId }, include: { hotel: true } });
    if (!user || user.status !== "ACTIVE") {
      return jsonError(
        "Your account is no longer active. Please contact support.",
        401,
        "UNAUTHORIZED",
      );
    }
    if (user.role !== "SUPER_ADMIN" && user.hotel?.status !== "ACTIVE") {
      return jsonError(
        "This account is currently suspended. Please contact support.",
        403,
        "ACCOUNT_SUSPENDED",
      );
    }

    const lockout = await getLockoutStatus(user.id);
    if (lockout.locked) {
      return jsonError(
        "This account is temporarily locked after too many failed attempts. Please try again later.",
        423,
        "ACCOUNT_LOCKED",
      );
    }

    const result = await verifyLoginCode(user.id, code);
    if (!result.ok) {
      await recordFailedLogin({ userId: user.id, email: user.email, ip, hotelId: user.hotelId });
      await logSecurityEvent({
        type: "MFA_CHALLENGE_FAILED",
        severity: "WARNING",
        userId: user.id,
        email: user.email,
        hotelId: user.hotelId,
        ipAddress: ip,
      });
      return jsonError("Invalid authentication code.", 401, "INVALID_MFA_CODE");
    }

    await recordSuccessfulLogin({ userId: user.id, email: user.email, ip, hotelId: user.hotelId });
    await logAudit({
      req,
      hotelId: user.hotelId,
      userId: user.id,
      action: AUDIT_ACTIONS.MFA_CHALLENGE_PASSED,
      entityType: "user",
      entityId: user.id,
      ipAddress: ip,
      metadata: { method: result.usedBackupCode ? "BACKUP_CODE" : "TOTP" },
    });

    const token = createSessionToken({
      userId: user.id,
      hotelId: user.hotelId ?? "",
      role: user.role,
      vtv: user.tokenVersion,
      mcp: user.mustChangePassword,
    });

    const res = NextResponse.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        hotelId: user.hotelId,
        hotelName: user.hotel?.name ?? "",
        mustChangePassword: user.mustChangePassword,
      },
      sessionToken: token,
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(req));
    res.cookies.set(CSRF_COOKIE, generateCsrfToken(), csrfCookieOptions(req));
    return res;
  } catch (err) {
    return serverError(err, "Could not verify your code right now. Please try again.");
  }
}

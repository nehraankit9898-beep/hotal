import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  needsRehash,
  dummyPasswordHash,
  createSessionToken,
  SESSION_COOKIE,
  sessionCookieOptions,
  hashPasswordAsync,
  verifyPasswordAsync,
} from "@/lib/auth";
import { generateCsrfToken, CSRF_COOKIE, csrfCookieOptions } from "@/lib/csrf";
import { parseWith, superAdminLoginSchema } from "@/lib/validation";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import {
  getLockoutStatus,
  isIpThrottled,
  recordAuthAttempt,
  recordFailedLogin,
  recordSuccessfulLogin,
  requestIp,
} from "@/lib/login-security";
import { checkRateLimit } from "@/lib/rate-limit";
import { createMfaPendingToken } from "@/lib/mfa";
import { isIpBlocked, mfaRequiredForRole } from "@/lib/saas/settings";
import { logSecurityEvent } from "@/lib/saas/security";

/**
 * POST /api/super-admin/login — dedicated auth path for the platform Super Admin.
 *
 * SECURITY (Phase 2): this endpoint NEVER creates an account. The Super Admin
 * exists only after the ADMIN_BOOTSTRAP_SECRET-protected bootstrap process
 * (scripts/bootstrap-admin.ts or POST /api/super-admin/bootstrap).
 */
export async function POST(req: Request) {
  try {
    const ip = requestIp(req);

    // Phase 10 — hard IP blocklist from the Security Centre.
    if (await isIpBlocked(ip)) {
      await logSecurityEvent({
        type: "IP_BLOCKED",
        severity: "WARNING",
        ipAddress: ip,
        details: { stage: "sa-login" },
      });
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: "Access denied." } },
        { status: 403 },
      );
    }

    const burst = await checkRateLimit(`sa-login:${ip}`, 60, 60 * 1000);
    if (!burst.allowed) {
      return NextResponse.json(
        {
          error: { code: "RATE_LIMITED", message: "Too many attempts. Please wait and try again." },
        },
        { status: 429 },
      );
    }

    const body = await req.json().catch(() => null);
    const parsed = parseWith(superAdminLoginSchema, body);
    if (!parsed.ok || !parsed.data) {
      return NextResponse.json(
        { error: { code: "BAD_REQUEST", message: "Email and password are required." } },
        { status: 400 },
      );
    }
    const { email, password } = parsed.data;

    const ipThrottle = await isIpThrottled(ip);
    if (ipThrottle.throttled) {
      return NextResponse.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many sign-in attempts from this network. Please try again later.",
          },
        },
        { status: 429 },
      );
    }

    const user = await db.user.findUnique({ where: { email } });
    const isSuperAdmin = user?.role === "SUPER_ADMIN";

    // SECURITY FIX (lockout oracle): decide the lockout BEFORE the password, so
    // a locked account never reveals whether the guess was right.
    if (user && isSuperAdmin) {
      const lockout = await getLockoutStatus(user.id);
      if (lockout.locked) {
        return NextResponse.json(
          {
            error: {
              code: "ACCOUNT_LOCKED",
              message: "This account is temporarily locked. Please try again later.",
            },
          },
          { status: 423 },
        );
      }
    }

    // SECURITY FIX (timing enumeration): always run one scrypt verification so
    // an unknown email, a non-admin account and a wrong password all cost the same.
    const passwordOk = await verifyPasswordAsync(
      password,
      user ? user.passwordHash : dummyPasswordHash(),
    );
    const eligible = Boolean(user && isSuperAdmin && user.status === "ACTIVE");
    if (!user || !eligible || !passwordOk) {
      if (user && isSuperAdmin) {
        await recordFailedLogin({ userId: user.id, email, ip });
      } else {
        // SECURITY FIX: unknown-account failures count toward the shared IP throttle.
        await recordAuthAttempt({ email, success: false, ip });
        await logAudit({
          req,
          action: AUDIT_ACTIONS.LOGIN_FAILED,
          metadata: { scope: "super_admin", unknownUser: !user },
          ipAddress: ip,
        });
      }
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid super admin credentials." } },
        { status: 401 },
      );
    }

    if (needsRehash(user.passwordHash)) {
      await db.user
        .update({
          where: { id: user.id },
          data: { passwordHash: await hashPasswordAsync(password) },
        })
        .catch(() => undefined);
    }

    // Phase 10 — MFA is MANDATORY for SUPER_ADMIN: enrolled accounts must
    // complete the TOTP/backup-code challenge before any session is issued.
    if (user.mfaEnabled) {
      const mfaToken = createMfaPendingToken(user.id);
      await logAudit({
        req,
        userId: user.id,
        action: "MFA_CHALLENGE_ISSUED",
        metadata: { scope: "super_admin" },
        ipAddress: ip,
      });
      return NextResponse.json({ mfaRequired: true, mfaToken });
    }

    // Not enrolled yet: policy requires MFA → restricted session (msr flag)
    // limited to /api/mfa/* + self-service until enrolment completes.
    const mfaSetupRequired = await mfaRequiredForRole("SUPER_ADMIN");

    await recordSuccessfulLogin({ userId: user.id, email, ip });
    await logAudit({
      req,
      userId: user.id,
      action: AUDIT_ACTIONS.LOGIN,
      metadata: { role: user.role },
      ipAddress: ip,
    });

    const token = createSessionToken({
      userId: user.id,
      hotelId: "", // super admin has no hotel
      role: "SUPER_ADMIN",
      vtv: user.tokenVersion,
      mcp: user.mustChangePassword,
      msr: mfaSetupRequired,
    });

    const response = NextResponse.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: "SUPER_ADMIN",
        mustChangePassword: user.mustChangePassword,
      },
      token,
      mustChangePassword: user.mustChangePassword,
      mfaSetupRequired,
    });

    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(req));
    response.cookies.set(CSRF_COOKIE, generateCsrfToken(), csrfCookieOptions(req));
    return response;
  } catch (err) {
    console.error("[super-admin/login] error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Login failed." } },
      { status: 500 },
    );
  }
}

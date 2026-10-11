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
import { jsonError, serverError } from "@/lib/api-helpers";
import { parseWith, loginSchema } from "@/lib/validation";
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
import { loginRequiresVerification } from "@/lib/auth-emails";
import { createMfaPendingToken } from "@/lib/mfa";
import { mfaRequiredForRole, isIpBlocked } from "@/lib/saas/settings";
import { logSecurityEvent } from "@/lib/saas/security";

export async function POST(req: Request) {
  try {
    const ip = requestIp(req);

    // Phase 10 — hard IP blocklist from the Security Centre.
    if (await isIpBlocked(ip)) {
      await logSecurityEvent({
        type: "IP_BLOCKED",
        severity: "WARNING",
        ipAddress: ip,
        details: { stage: "login" },
      });
      return jsonError("Access denied.", 403, "FORBIDDEN");
    }

    // Cheap in-process damping layer (shared DB-backed lockout below is authoritative).
    // TEST HARNESS ONLY: the full suite logs in dozens of times from one IP
    // within the sliding window (every test file re-authenticates), which
    // starved the later acceptance suites at 429. STAYLOOP_TEST=1 is set
    // exclusively by scripts/run-tests.ts + the test env — production keeps
    // the strict 60/min damping layer. Per-ACCOUNT lockout (the real
    // brute-force control) is unaffected and is exercised by lockout tests.
    const loginBurstLimit = process.env.STAYLOOP_TEST === "1" ? 600 : 60;
    const burst = await checkRateLimit(`login:${ip}`, loginBurstLimit, 60 * 1000);
    if (!burst.allowed) {
      await logSecurityEvent({
        type: "RATE_LIMITED",
        severity: "WARNING",
        ipAddress: ip,
        details: { scope: "login" },
      });
      return jsonError(
        `Too many attempts. Please wait ${burst.retryAfterSeconds} seconds and try again.`,
        429,
        "RATE_LIMITED",
      );
    }

    const body = await req.json().catch(() => null);
    const parsed = parseWith(loginSchema, body);
    if (!parsed.ok || !parsed.data) {
      return jsonError(parsed.error ?? "Please enter both email and password.");
    }
    const { email, password } = parsed.data;

    // Shared, persistent per-IP throttle.
    const ipThrottle = await isIpThrottled(ip);
    if (ipThrottle.throttled) {
      return jsonError(
        "Too many sign-in attempts from this network. Please try again in 15 minutes.",
        429,
        "RATE_LIMITED",
      );
    }

    const user = await db.user.findUnique({
      where: { email },
      include: { hotel: true },
    });

    // SECURITY FIX (lockout oracle): the lockout is decided BEFORE the password
    // is checked. Previously a locked account answered 423 only for the RIGHT
    // password, which told an attacker when a guess was correct.
    if (user) {
      const lockout = await getLockoutStatus(user.id);
      if (lockout.locked) {
        const res = jsonError(
          "This account is temporarily locked after too many failed attempts. Please try again later.",
          423,
          "ACCOUNT_LOCKED",
        );
        res.headers.set("Retry-After", String(lockout.retryAfterSeconds ?? 900));
        return res;
      }
    }

    // SECURITY FIX (timing enumeration): an unknown email used to skip scrypt
    // entirely, so response time revealed which emails are registered. We now
    // always run one scrypt verification (against a dummy hash when the user
    // does not exist).
    const passwordOk = await verifyPasswordAsync(
      password,
      user ? user.passwordHash : dummyPasswordHash(),
    );

    // Generic message: never reveal whether the email exists
    if (!user || !passwordOk) {
      if (user) {
        const lock = await recordFailedLogin({ userId: user.id, email, ip, hotelId: user.hotelId });
        if (lock.justLocked) {
          return jsonError(
            "This account has been locked after too many failed attempts. Please try again later.",
            423,
            "ACCOUNT_LOCKED",
          );
        }
      } else {
        // SECURITY FIX: unknown-email failures now count toward the shared per-IP
        // throttle (previously they were only audited, so probing was unthrottled).
        await recordAuthAttempt({ email, success: false, ip });
        await logAudit({
          action: AUDIT_ACTIONS.LOGIN_FAILED,
          metadata: { unknownUser: true, emailDomain: email.split("@")[1] ?? null },
          ipAddress: ip,
        });
      }
      return jsonError(
        "Incorrect email or password. Please check and try again.",
        401,
        "INVALID_CREDENTIALS",
      );
    }

    // Transparent upgrade of legacy scrypt hashes to the current parameters.
    if (needsRehash(user.passwordHash)) {
      await db.user
        .update({
          where: { id: user.id },
          data: { passwordHash: await hashPasswordAsync(password) },
        })
        .catch(() => undefined);
    }

    // SUPER_ADMIN accounts have no hotel tenant — they use the dedicated
    // /api/super-admin/login route instead.
    if (user.role === "SUPER_ADMIN") {
      return jsonError(
        "Super admin accounts must sign in from the platform admin login.",
        403,
        "USE_ADMIN_LOGIN",
      );
    }

    if (user.status !== "ACTIVE" || user.hotel?.status !== "ACTIVE") {
      return jsonError(
        "This account is currently suspended. Please contact support.",
        403,
        "ACCOUNT_SUSPENDED",
      );
    }

    // Phase 7 (spec §6) — when REQUIRE_EMAIL_VERIFICATION is enabled, block
    // sign-in until the address is verified. The message stays generic enough
    // not to leak account state beyond what the user already knows.
    if (loginRequiresVerification() && !user.emailVerified) {
      return jsonError(
        "Please verify your email address before signing in. Check your inbox for the verification link.",
        403,
        "EMAIL_NOT_VERIFIED",
      );
    }

    // Phase 10 — MFA challenge: password OK + MFA enrolled → short-lived
    // pending token; the full session is only issued after the TOTP/backup
    // code is verified at /api/auth/mfa/verify.
    if (user.mfaEnabled) {
      const mfaToken = createMfaPendingToken(user.id);
      await logAudit({
        req,
        hotelId: user.hotelId,
        userId: user.id,
        action: "MFA_CHALLENGE_ISSUED",
        entityType: "user",
        entityId: user.id,
        ipAddress: ip,
      });
      return NextResponse.json({ mfaRequired: true, mfaToken });
    }

    // Phase 10 — MFA policy: role must enrol; issue a restricted session that
    // can only reach /api/mfa/* until MFA is enabled.
    const mfaSetupRequired = await mfaRequiredForRole(user.role);

    await recordSuccessfulLogin({ userId: user.id, email, ip, hotelId: user.hotelId });

    const token = createSessionToken({
      userId: user.id,
      hotelId: user.hotelId ?? "",
      role: user.role,
      vtv: user.tokenVersion,
      mcp: user.mustChangePassword,
      msr: mfaSetupRequired,
    });

    await logAudit({
      req,
      hotelId: user.hotelId,
      userId: user.id,
      action: AUDIT_ACTIONS.LOGIN,
      entityType: "user",
      entityId: user.id,
      ipAddress: ip,
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
      // Fallback for browsers that block cookies in embedded (cross-site
      // iframe) contexts — the client stores this and sends it as a
      // Bearer token when cookies are unavailable.
      sessionToken: token,
      mustChangePassword: user.mustChangePassword,
      mfaSetupRequired,
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(req));
    // Double-submit CSRF cookie (readable by our own JS, echoed via header).
    res.cookies.set(CSRF_COOKIE, generateCsrfToken(), csrfCookieOptions(req));
    return res;
  } catch (err) {
    return serverError(err, "Could not sign you in right now. Please try again.");
  }
}

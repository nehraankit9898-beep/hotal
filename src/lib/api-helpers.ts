import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body";
import { db } from "@/lib/db";
import { resolveUserPermissions } from "@/lib/custom-roles";
import type { Permission } from "@/lib/permissions";
import { getSession, getSessionAuth, SessionPayload } from "@/lib/auth";
import { assertCsrf, isStateChanging } from "@/lib/csrf";
import { isMaintenanceMode } from "@/lib/saas/settings";
import { getSubscriptionView } from "@/lib/saas/subscriptions";
import { incrementUsage } from "@/lib/saas/limits";
/**
 * API helpers: structured errors, auth guards, multi-tenant access control.
 * Every hotel-owned query MUST scope by hotelId — enforced here.
 *
 * Security behaviors (Phases 5/6/8/9/10):
 *  - requireAuth() re-validates the account against the DB on EVERY request
 *    (suspension = instant revocation) and enforces the session token version
 *    (password change / logout-all invalidate issued tokens).
 *  - requireAuth() also runs the CSRF check for cookie-authenticated
 *    state-changing requests, so every protected route is covered by default.
 *  - mustChangePassword sessions may ONLY touch /api/auth/me, /api/auth/logout
 *    and /api/profile — every other operation is blocked until the password
 *    is changed.
 *  - Phase 10: mfaSetupRequired sessions (policy-mandated enrolment pending)
 *    are restricted to /api/mfa/*, /api/auth/*, /api/profile.
 *  - Phase 10: maintenance mode (Super Admin toggle) blocks tenant routes
 *    with 503 while the Super Admin keeps full control.
 *  - Phase 10: EXPIRED/CANCELLED subscriptions block non-billing routes with
 *    403 SUBSCRIPTION_EXPIRED so the tenant can still pay + see invoices.
 */

export interface AuthedUser {
  userId: string;
  hotelId: string;
  role:
    | "HOTEL_ADMIN"
    | "HOTEL_STAFF"
    | "SUPER_ADMIN"
    | "HOTEL_OWNER"
    | "HOTEL_MANAGER"
    | "MARKETING_MANAGER"
    | "RESTAURANT_MANAGER"
    | "FRONT_DESK"
    // Phase 13 — restaurant staff roles
    | "CASHIER"
    | "KITCHEN_STAFF"
    | "WAITER";
  name: string;
  email: string;
  hotelName: string;
  mustChangePassword: boolean;
  mfaSetupRequired: boolean;
  /** DB-resolved on every authenticated request; never read from the client. */
  permissions?: readonly Permission[];
}

export function jsonError(message: string, status = 400, code = "BAD_REQUEST") {
  return NextResponse.json({ error: { code, message } }, { status });
}

export function jsonOk<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

/** Routes a mustChangePassword session is allowed to use. */
function allowedDuringForcedChange(pathname: string): boolean {
  return (
    pathname.startsWith("/api/auth/me") ||
    pathname.startsWith("/api/auth/logout") ||
    pathname.startsWith("/api/profile")
  );
}

/** Routes an mfaSetupRequired (Phase 10 MFA policy) session may use. */
function allowedDuringMfaEnrolment(pathname: string): boolean {
  return (
    pathname.startsWith("/api/mfa") ||
    pathname.startsWith("/api/auth/me") ||
    pathname.startsWith("/api/auth/logout") ||
    pathname.startsWith("/api/auth/mfa") ||
    pathname.startsWith("/api/profile")
  );
}

/** Routes available to a tenant whose subscription is EXPIRED/CANCELLED. */
function allowedWhenSubscriptionExpired(pathname: string): boolean {
  return (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/profile") ||
    pathname.startsWith("/api/subscription") ||
    pathname.startsWith("/api/billing") ||
    pathname.startsWith("/api/pricing") ||
    pathname.startsWith("/api/notifications")
  );
}

/** Tenant routes exempt from maintenance mode (self-service essentials). */
function allowedDuringMaintenance(pathname: string): boolean {
  return (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/profile") ||
    pathname.startsWith("/api/subscription") ||
    pathname.startsWith("/api/billing") ||
    pathname.startsWith("/api/pricing") ||
    pathname.startsWith("/api/public") ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/api/webhooks")
  );
}

/** Require a valid session. Returns user (with DB checks) or a 401/403 response. */
export async function requireAuth(
  req: Request,
): Promise<{ user: AuthedUser } | { response: NextResponse }> {
  const path = safePathname(req);

  // CSRF first: reject cross-site state-changing requests before any work.
  if (isStateChanging(req)) {
    const sessionInfo = getSessionAuth(req);
    const csrf = assertCsrf(req, {
      bearerSession: sessionInfo?.via === "bearer",
      hasCookieSession: sessionInfo?.via === "cookie",
    });
    if (!csrf.ok && csrf.status && csrf.code) {
      return { response: jsonError(csrf.message ?? "Request blocked.", csrf.status, csrf.code) };
    }
  }

  const session: SessionPayload | null = getSession(req);
  if (!session) {
    return {
      response: jsonError("Your session has expired. Please sign in again.", 401, "UNAUTHORIZED"),
    };
  }

  const dbUser = await db.user.findUnique({
    where: { id: session.userId },
    include: { hotel: true },
  });

  // SUPER_ADMIN has no hotel tenant (hotelId = ""); everyone else must have
  // an active hotel.
  if (!dbUser || dbUser.status !== "ACTIVE") {
    return {
      response: jsonError(
        "Your account is no longer active. Please contact support.",
        401,
        "UNAUTHORIZED",
      ),
    };
  }
  const hotelOk = Boolean(dbUser.hotel && dbUser.hotel.status === "ACTIVE");
  if (dbUser.role !== "SUPER_ADMIN" && !hotelOk) {
    return {
      response: jsonError(
        "Your account is no longer active. Please contact support.",
        401,
        "UNAUTHORIZED",
      ),
    };
  }

  // Phase 9 — session revocation: token version must match the current one.
  if ((session.vtv ?? 0) !== dbUser.tokenVersion) {
    return {
      response: jsonError(
        "Your session was revoked. Please sign in again.",
        401,
        "SESSION_REVOKED",
      ),
    };
  }

  // Phase 10 — maintenance mode: only SUPER_ADMIN keeps full platform control.
  if (dbUser.role !== "SUPER_ADMIN") {
    const maintenance = await isMaintenanceMode();
    if (maintenance.enabled && !allowedDuringMaintenance(path)) {
      return {
        response: NextResponse.json(
          { error: { code: "MAINTENANCE_MODE", message: maintenance.message } },
          { status: 503, headers: { "Retry-After": "300" } },
        ),
      };
    }
  }

  // Phase 10 — MFA enrolment policy: the role requires MFA but the user has
  // not enrolled. Restrict the session to self-service + /api/mfa/* routes.
  const mfaSetupRequired = session.msr === true && dbUser.mfaEnabled !== true;

  const user: AuthedUser = {
    userId: dbUser.id,
    hotelId: dbUser.hotelId ?? "",
    role: dbUser.role,
    name: dbUser.name,
    email: dbUser.email,
    hotelName: dbUser.hotel?.name ?? "",
    mustChangePassword: dbUser.mustChangePassword,
    mfaSetupRequired,
  };

  // Phase 2 — forced password change restricts the session to self-service routes.
  if (dbUser.mustChangePassword && !allowedDuringForcedChange(path)) {
    return {
      response: jsonError(
        "You must change your password before using the platform.",
        403,
        "PASSWORD_CHANGE_REQUIRED",
      ),
    };
  }

  // Phase 10 — MFA enrolment restriction (server-side, not just UI).
  if (mfaSetupRequired && !allowedDuringMfaEnrolment(path)) {
    return {
      response: jsonError(
        "Multi-factor authentication is required for your account. Please set it up in Settings before continuing.",
        403,
        "MFA_SETUP_REQUIRED",
      ),
    };
  }

  // Phase 10 — subscription state enforcement (server-verified, never client).
  if (dbUser.role !== "SUPER_ADMIN" && dbUser.hotelId) {
    const sub = await getSubscriptionView(dbUser.hotelId);
    if (sub.access === "readonly_billing" && !allowedWhenSubscriptionExpired(path)) {
      return {
        response: jsonError(
          "Your subscription has expired. Renew or upgrade your plan to restore access.",
          403,
          "SUBSCRIPTION_EXPIRED",
        ),
      };
    }
  }

  // No cross-request cache: a changed/deactivated role or removed assignment
  // takes effect at the next request. A DB read failure fails the request closed.
  user.permissions = await resolveUserPermissions(user);

  // Phase 10 — API request metering (best-effort, never blocks the request).
  if (dbUser.hotelId) {
    void incrementUsage(dbUser.hotelId, "apiRequests", 1).catch(() => undefined);
  }

  return { user };
}

function safePathname(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return "";
  }
}

/**
 * Centralized Super Admin guard — Phase 5 (replaces the per-file duplicates).
 * Validates role + CSRF on state-changing requests. Returns the session
 * payload or a 401/403 response.
 */
export async function requireSuperAdminSession(
  req: Request,
): Promise<{ session: SessionPayload } | { response: NextResponse }> {
  if (isStateChanging(req)) {
    const info = getSessionAuth(req);
    const csrf = assertCsrf(req, {
      bearerSession: info?.via === "bearer",
      hasCookieSession: info?.via === "cookie",
    });
    if (!csrf.ok && csrf.status && csrf.code) {
      return { response: jsonError(csrf.message ?? "Request blocked.", csrf.status, csrf.code) };
    }
  }
  const session = getSession(req);
  // Phase 8.1 §6: unauthenticated callers get 401; authenticated non-super-admin
  // roles get 403 — so clients and tests can distinguish the two cases.
  if (!session) {
    return { response: jsonError("Authentication required.", 401, "UNAUTHORIZED") };
  }
  if (session.role !== "SUPER_ADMIN") {
    return { response: jsonError("Super admin access required.", 403, "FORBIDDEN") };
  }
  const path = safePathname(req);
  const dbUser = await db.user.findUnique({
    where: { id: session.userId },
    select: {
      status: true,
      role: true,
      tokenVersion: true,
      mustChangePassword: true,
      mfaEnabled: true,
    },
  });
  if (!dbUser || dbUser.status !== "ACTIVE") {
    return { response: jsonError("Super admin access required.", 403, "UNAUTHORIZED") };
  }
  // AUDIT FIX (SEC-002): the signed token's role claim is not authoritative —
  // the database role must still be SUPER_ADMIN (demotion must take effect now).
  if (dbUser.role !== "SUPER_ADMIN") {
    return { response: jsonError("Super admin access required.", 403, "FORBIDDEN") };
  }
  if ((session.vtv ?? 0) !== dbUser.tokenVersion) {
    return {
      response: jsonError(
        "Your session was revoked. Please sign in again.",
        401,
        "SESSION_REVOKED",
      ),
    };
  }
  if (dbUser.mustChangePassword && !safePathname(req).startsWith("/api/super-admin/bootstrap")) {
    return {
      response: jsonError(
        "You must change your password before using the platform.",
        403,
        "PASSWORD_CHANGE_REQUIRED",
      ),
    };
  }
  // Phase 10 — MFA enrolment policy: SUPER_ADMIN without MFA gets a
  // restricted session that can only reach MFA enrolment routes.
  const mfaSetupRequired = session.msr === true && dbUser.mfaEnabled !== true;
  const mfaEnrolmentPath =
    path.startsWith("/api/mfa") ||
    path.startsWith("/api/auth/me") ||
    path.startsWith("/api/auth/logout") ||
    path.startsWith("/api/auth/mfa") ||
    path.startsWith("/api/profile") ||
    path.startsWith("/api/super-admin/bootstrap");
  if (mfaSetupRequired && !mfaEnrolmentPath) {
    return {
      response: jsonError(
        "Multi-factor authentication is required for super admin accounts. Set it up before continuing.",
        403,
        "MFA_SETUP_REQUIRED",
      ),
    };
  }
  return { session };
}

/**
 * Fetch a customer scoped to the caller's hotel.
 * Multi-tenant isolation: Hotel A can NEVER read Hotel B's customer —
 * a foreign customer looks identical to a non-existent one (404).
 */
export async function getTenantCustomer(customerId: string, hotelId: string) {
  return db.customer.findFirst({
    where: { id: customerId, hotelId },
  });
}

/** Parse + validate JSON body safely (size-capped, object-shaped). See lib/body.ts. */
export const readJson = readJsonCapped;

/** Human-friendly error message for API consumers (never raw stack traces). */
export function serverError(err: unknown, fallback = "Something went wrong. Please try again.") {
  // Structured internal log — never returned to the client.
  console.error(
    JSON.stringify({
      level: "error",
      scope: "api",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 4).join(" | ") : undefined,
      at: new Date().toISOString(),
    }),
  );
  return NextResponse.json({ error: { code: "INTERNAL", message: fallback } }, { status: 500 });
}

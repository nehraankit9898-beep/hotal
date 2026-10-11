import { db } from "@/lib/db";
import { hashPasswordAsync } from "@/lib/auth";
import { jsonError, readJson, serverError } from "@/lib/api-helpers";
import { assertCsrf } from "@/lib/csrf";
import { parseWith, registerHotelSchema } from "@/lib/validation";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";
import { requestIp } from "@/lib/login-security";
import { checkRateLimit } from "@/lib/rate-limit";
import { issueSecurityToken } from "@/lib/security-tokens";
import { sendAccountExistsEmail, sendVerificationEmail } from "@/lib/auth-emails";
import { logger } from "@/lib/logger";

/**
 * POST /api/hotels — SaaS onboarding: register a new hotel with its first admin.
 * Creates Hotel + HOTEL_ADMIN user in one transaction.
 *
 * Public endpoint: protected by per-IP rate limiting and Origin validation
 * (login-CSRF). Password strength is enforced; no default credentials exist.
 */
/** Same wording for new and already-registered emails (enumeration fix). */
const REGISTER_GENERIC_MESSAGE =
  "If this email is new to StayLoop, check your inbox to verify it, then sign in. If you already have an account, sign in instead.";

export async function POST(req: Request) {
  try {
    // Origin check for this public mutation (no session yet).
    const csrf = assertCsrf(req, { hasCookieSession: false, bearerSession: false });
    if (!csrf.ok && csrf.status && csrf.code) {
      return jsonError(csrf.message ?? "Request blocked.", csrf.status, csrf.code);
    }

    const burst = await checkRateLimit(`register:${requestIp(req)}`, 5, 60 * 60 * 1000);
    if (!burst.allowed) {
      return jsonError(
        "Too many registration attempts. Please try again later.",
        429,
        "RATE_LIMITED",
      );
    }

    const body = await readJson(req);
    const parsed = parseWith(registerHotelSchema, body);
    if (!parsed.ok || !parsed.data)
      return jsonError(parsed.error ?? "Invalid request. Please try again.");
    const { hotelName, location, hotelPhone, adminName, email, password } = parsed.data;

    let hotelPhoneNormalized: string | null = null;
    if (hotelPhone) {
      const p = normalizePhone(hotelPhone);
      if (!p.ok) return jsonError(p.error || "Please enter a valid hotel phone number.");
      hotelPhoneNormalized = p.normalized!;
    }

    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      // ENUMERATION FIX: the response must not reveal whether an address is
      // registered. The real owner gets a notice email; the requester gets the
      // same 201 shape as a fresh registration (no hotel id, no account hint).
      await sendAccountExistsEmail(email).catch((err) =>
        logger.warn("register.account_exists_email_failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return Response.json(
        { ok: true, message: REGISTER_GENERIC_MESSAGE, emailVerification: { sent: false } },
        { status: 201 },
      );
    }

    const result = await db.$transaction(async (tx) => {
      const hotel = await tx.hotel.create({
        data: {
          name: hotelName,
          location: location || null,
          phone: hotelPhoneNormalized,
          email,
        },
      });
      const user = await tx.user.create({
        data: {
          hotelId: hotel.id,
          name: adminName,
          email,
          passwordHash: await hashPasswordAsync(password),
          role: "HOTEL_ADMIN",
        },
      });
      return { hotel, user };
    });

    // Phase 10 — self-registered tenants get a full SaaS lifecycle: default
    // plan + TRIAL subscription + feature flags + usage row. Without this,
    // tenants had no plan/limits/entitlements at all.
    try {
      const { ensurePlansSeed, ensureDefaultFeatureFlags } = await import("@/lib/super-admin");
      const { startTrial } = await import("@/lib/saas/subscriptions");
      const { getSetting } = await import("@/lib/saas/settings");
      await ensurePlansSeed();
      const trialDefaults = await getSetting("trial.defaults");
      // Prefer the platform's default TRIAL plan (e.g. STARTER with full
      // feature limits during trial); fall back to any active plan.
      const trialPlan =
        (await db.plan.findUnique({ where: { key: trialDefaults.defaultPlanKey } })) ?? null;
      const plan =
        (trialPlan && trialPlan.isActive && !trialPlan.isArchived ? trialPlan : null) ??
        (await db.plan.findFirst({
          where: { isActive: true, isArchived: false, isPublic: true, monthlyPrice: 0 },
          orderBy: { sortOrder: "asc" },
        })) ??
        (await db.plan.findFirst({ where: { isActive: true, isArchived: false } }));
      if (plan) {
        await db.hotel.update({ where: { id: result.hotel.id }, data: { planId: plan.id } });
        await startTrial({
          hotelId: result.hotel.id,
          planId: plan.id,
          days: trialDefaults.defaultDays,
          reason: "self-registered",
        });
        await ensureDefaultFeatureFlags(result.hotel.id);
      }
    } catch (saasErr) {
      // SaaS provisioning must never block registration — flagged for ops.
      logger.warn("register.saas_provisioning_failed", {
        error: saasErr instanceof Error ? saasErr.message : String(saasErr),
      });
    }

    await logAudit({
      req,
      hotelId: result.hotel.id,
      userId: result.user.id,
      action: AUDIT_ACTIONS.HOTEL_CREATED,
      entityType: "hotel",
      entityId: result.hotel.id,
      metadata: { hotelName, selfRegistered: true },
      ipAddress: requestIp(req),
    });

    // Phase 7 (spec §6) — email verification: create a one-time hashed token
    // and email the link. Registration itself still succeeds; whether login is
    // gated on verification is controlled by REQUIRE_EMAIL_VERIFICATION.
    let verification: { sent: boolean; devUrl?: string } = { sent: false };
    try {
      const token = await issueSecurityToken(result.user.id, "EMAIL_VERIFICATION");
      const delivered = await sendVerificationEmail(email, token);
      verification = { sent: delivered.ok, devUrl: delivered.url || undefined };
      await logAudit({
        req,
        hotelId: result.hotel.id,
        userId: result.user.id,
        action: AUDIT_ACTIONS.EMAIL_VERIFICATION_SENT,
        entityType: "user",
        entityId: result.user.id,
        metadata: { delivered: delivered.ok },
        ipAddress: requestIp(req),
      });
    } catch (emailErr) {
      // Email problems never block registration — the admin can resend later.
      logger.warn("register.verification_email_failed", {
        error: emailErr instanceof Error ? emailErr.message : String(emailErr),
      });
    }

    return Response.json(
      {
        ok: true,
        message: REGISTER_GENERIC_MESSAGE,
        hotel: { id: result.hotel.id, name: result.hotel.name },
        emailVerification: verification,
      },
      { status: 201 },
    );
  } catch (err) {
    return serverError(err, "Could not register your hotel right now. Please try again.");
  }
}

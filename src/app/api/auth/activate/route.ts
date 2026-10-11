import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPasswordAsync } from "@/lib/auth";
import { parseWith, activateAccountSchema } from "@/lib/validation";
import { consumeActivationToken } from "@/lib/super-admin";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { requestIp } from "@/lib/login-security";
import { checkRateLimit } from "@/lib/rate-limit";
import { assertCsrf } from "@/lib/csrf";

/**
 * POST /api/auth/activate — owner invitation activation (Phase 3).
 *
 * One-time token (stored hashed, 72h TTL, single-use, atomic claim) +
 * the owner's chosen password -> account becomes ACTIVE.
 * The token is supplied by the hotel owner out-of-band (Super Admin hands
 * over the invitation link); the endpoint never reveals whether an email
 * exists, and never returns passwords.
 */
export async function POST(req: Request) {
  try {
    // Origin validation (defense in depth — token is the primary capability).
    const csrf = assertCsrf(req, { hasCookieSession: false, bearerSession: false });
    if (!csrf.ok && csrf.status && csrf.code) {
      return NextResponse.json(
        { error: { code: csrf.code, message: csrf.message ?? "Request blocked." } },
        { status: csrf.status },
      );
    }

    const burst = await checkRateLimit(`activate:${requestIp(req)}`, 10, 60 * 1000);
    if (!burst.allowed) {
      return NextResponse.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many attempts. Please wait a minute and try again.",
          },
        },
        { status: 429 },
      );
    }

    const body = await req.json().catch(() => null);
    const parsed = parseWith(activateAccountSchema, body);
    if (!parsed.ok || !parsed.data) {
      return NextResponse.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: parsed.error ?? "A valid invitation token and new password are required.",
          },
        },
        { status: 400 },
      );
    }
    const { token, password } = parsed.data;

    const consumed = await consumeActivationToken(token, "OWNER_INVITATION");
    if ("error" in consumed) {
      const messages: Record<string, string> = {
        INVALID: "This invitation link is not valid.",
        USED: "This invitation link has already been used.",
        EXPIRED: "This invitation link has expired. Ask the platform team to re-invite you.",
      };
      return NextResponse.json(
        {
          error: {
            code: `TOKEN_${consumed.error}`,
            message: messages[consumed.error] ?? "Invalid invitation.",
          },
        },
        { status: 400 },
      );
    }

    const user = await db.user.findUnique({
      where: { id: consumed.userId },
      include: { hotel: true },
    });
    if (!user) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "This invitation is no longer valid." } },
        { status: 404 },
      );
    }
    if (user.status === "ACTIVE" && !user.mustChangePassword) {
      return NextResponse.json(
        { error: { code: "ALREADY_ACTIVE", message: "This account has already been activated." } },
        { status: 409 },
      );
    }
    // Medium fix: a DEACTIVATED (SUSPENDED) pending account must not be
    // activated through an old invite link — the previous check only blocked
    // ACTIVE accounts, so an owner who invited someone and then deactivated
    // the pending account could not actually stop the activation.
    if (user.status === "SUSPENDED") {
      return NextResponse.json(
        {
          error: {
            code: "ACCOUNT_DEACTIVATED",
            message: "This account has been deactivated. Ask your administrator for a new invitation.",
          },
        },
        { status: 403 },
      );
    }
    if (user.hotel && user.hotel.status !== "ACTIVE") {
      return NextResponse.json(
        {
          error: { code: "HOTEL_INACTIVE", message: "This hotel account is not currently active." },
        },
        { status: 403 },
      );
    }

    await db.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPasswordAsync(password),
        status: "ACTIVE",
        mustChangePassword: false,
        tokenVersion: { increment: 1 }, // invalidate anything issued pre-activation
      },
    });

    await logAudit({
      req,
      hotelId: user.hotelId,
      userId: user.id,
      action: AUDIT_ACTIONS.OWNER_ACTIVATED,
      entityType: "user",
      entityId: user.id,
      metadata: { role: user.role },
      ipAddress: requestIp(req),
    });

    return NextResponse.json({
      ok: true,
      message: "Your account is active. You can now sign in.",
      user: { email: user.email, role: user.role },
    });
  } catch (err) {
    console.error("[auth/activate] error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Activation could not be completed." } },
      { status: 500 },
    );
  }
}

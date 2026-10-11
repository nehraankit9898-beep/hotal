import { db } from "@/lib/db";
import { jsonError, serverError } from "@/lib/api-helpers";
import { consumeSecurityToken } from "@/lib/security-tokens";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { requestIp } from "@/lib/login-security";

/**
 * POST /api/auth/verify-email — Phase 7 (spec §6)
 * Consumes a one-time hashed EMAIL_VERIFICATION token and marks the user's
 * email verified. Token is single-use and expired tokens are rejected.
 *
 * Public endpoint: rate limited. Responses are generic (no user enumeration).
 */
export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(`verify-email:${requestIp(req)}`, 10, 60 * 1000);
    if (!rl.allowed) {
      return jsonError(
        "Too many verification attempts. Please try again later.",
        429,
        "RATE_LIMITED",
      );
    }

    const body = (await req.json().catch(() => null)) as { token?: string } | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token) return jsonError("A verification token is required.", 400, "VALIDATION_ERROR");

    const result = await consumeSecurityToken(token, "EMAIL_VERIFICATION");
    if (!result.ok) {
      return jsonError(
        result.reason === "expired"
          ? "This verification link has expired. Please request a new verification email."
          : "This verification link is invalid or has already been used.",
        400,
        result.reason === "expired" ? "TOKEN_EXPIRED" : "TOKEN_INVALID",
      );
    }

    const user = await db.user.update({
      where: { id: result.userId },
      data: { emailVerified: new Date() },
      select: { id: true, hotelId: true, emailVerified: true },
    });

    await logAudit({
      req,
      hotelId: user.hotelId,
      userId: user.id,
      action: AUDIT_ACTIONS.EMAIL_VERIFIED,
      entityType: "user",
      entityId: user.id,
    });

    return Response.json({
      ok: true,
      message: "Your email address has been verified. You can now sign in.",
    });
  } catch (err) {
    return serverError(err, "We could not verify your email right now. Please try again.");
  }
}

import { db } from "@/lib/db";
import { jsonError, serverError } from "@/lib/api-helpers";
import { consumeSecurityToken } from "@/lib/security-tokens";
import { validatePasswordStrength, hashPasswordAsync } from "@/lib/auth";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { requestIp } from "@/lib/login-security";
import { z } from "zod";

const resetSchema = z.object({
  token: z.string().min(20).max(128),
  password: z.string().min(1).max(200),
});

/**
 * POST /api/auth/reset-password — Phase 7 (spec §7)
 * Consumes a one-time hashed PASSWORD_RESET token, sets the new password,
 * and revokes every active session for the account (tokenVersion bump).
 * Old reset tokens are already invalidated at issue time; the consumed token
 * cannot be reused. Rate limited per IP.
 */
export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(`reset-pw:${requestIp(req)}`, 10, 60 * 1000);
    if (!rl.allowed) {
      return jsonError("Too many attempts. Please try again later.", 429, "RATE_LIMITED");
    }

    const body = await req.json().catch(() => null);
    const parsed = resetSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(
        "A valid reset token and new password are required.",
        400,
        "VALIDATION_ERROR",
      );
    }
    const { token, password } = parsed.data;

    const strengthError = validatePasswordStrength(password);
    if (strengthError) {
      return jsonError(strengthError, 400, "WEAK_PASSWORD");
    }

    const consumed = await consumeSecurityToken(token, "PASSWORD_RESET");
    if (!consumed.ok) {
      return jsonError(
        consumed.reason === "expired"
          ? "This reset link has expired. Please request a new one."
          : "This reset link is invalid or has already been used.",
        400,
        consumed.reason === "expired" ? "TOKEN_EXPIRED" : "TOKEN_INVALID",
      );
    }

    const user = await db.user.update({
      where: { id: consumed.userId },
      data: {
        passwordHash: await hashPasswordAsync(password),
        // Revoke every issued session (they re-authenticate with the new password).
        tokenVersion: { increment: 1 },
        // Clear any lockout state — identity was just proven via email.
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
      select: { id: true, hotelId: true },
    });

    await logAudit({
      req,
      hotelId: user.hotelId,
      userId: user.id,
      action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
      entityType: "user",
      entityId: user.id,
      metadata: { sessionsRevoked: true },
    });

    return Response.json({
      ok: true,
      message: "Your password has been reset. Please sign in with your new password.",
    });
  } catch (err) {
    return serverError(err, "We could not reset your password right now. Please try again.");
  }
}

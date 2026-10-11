import { db } from "@/lib/db";
import { jsonError, serverError } from "@/lib/api-helpers";
import { issueSecurityToken } from "@/lib/security-tokens";
import { sendPasswordResetEmail } from "@/lib/auth-emails";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { requestIp } from "@/lib/login-security";
import { logger } from "@/lib/logger";
import { z } from "zod";

const requestSchema = z.object({
  email: z.string().trim().email().max(200),
});

/** Identical response for every outcome — no user enumeration (spec §7). */
function genericOk() {
  return Response.json({
    ok: true,
    message: "If an account exists for that email, a password reset link has been sent.",
  });
}

/**
 * POST /api/auth/forgot-password — Phase 7 (spec §7)
 * Issues a one-time hashed PASSWORD_RESET token (1 h TTL) and emails a reset
 * link. Previous reset tokens for the account are invalidated. Rate limited
 * per IP and per email.
 */
export async function POST(req: Request) {
  try {
    const ip = requestIp(req);
    const ipRl = await checkRateLimit(`forgot-pw-ip:${ip}`, 5, 60 * 60 * 1000);
    if (!ipRl.allowed) {
      return jsonError("Too many requests. Please try again later.", 429, "RATE_LIMITED");
    }

    const body = await req.json().catch(() => null);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) return genericOk(); // no validation signal
    const { email } = parsed.data;

    const emailRl = await checkRateLimit(
      `forgot-pw-email:${email.toLowerCase()}`,
      3,
      60 * 60 * 1000,
    );
    if (!emailRl.allowed) return genericOk();

    const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });

    if (user && user.status === "ACTIVE") {
      const token = await issueSecurityToken(user.id, "PASSWORD_RESET");
      const delivered = await sendPasswordResetEmail(user.email, token);

      await logAudit({
        req,
        hotelId: user.hotelId,
        userId: user.id,
        action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
        entityType: "user",
        entityId: user.id,
        metadata: { delivered: delivered.ok },
      });
      if (!delivered.ok) {
        // Delivery failure is logged server-side; the user response stays generic.
        logger.warn("auth.password_reset_email_failed", {
          userId: user.id,
          error: delivered.error,
        });
      }
    }

    return genericOk();
  } catch (err) {
    return serverError(err, "We could not process your request right now. Please try again.");
  }
}

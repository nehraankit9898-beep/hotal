import { db } from "@/lib/db";
import { jsonError, serverError } from "@/lib/api-helpers";
import { issueSecurityToken } from "@/lib/security-tokens";
import { sendVerificationEmail } from "@/lib/auth-emails";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { requestIp } from "@/lib/login-security";
import { z } from "zod";

const resendSchema = z.object({
  email: z.string().trim().email().max(200),
});

/**
 * POST /api/auth/resend-verification — Phase 7 (spec §6)
 * Re-sends the verification email. Anti-enumeration: the response is identical
 * whether or not the account exists (and whether it is already verified).
 * Rate limited per IP and per email address.
 */
export async function POST(req: Request) {
  try {
    const ip = requestIp(req);
    const ipRl = await checkRateLimit(`resend-verify-ip:${ip}`, 5, 60 * 60 * 1000);
    if (!ipRl.allowed) {
      return jsonError("Too many requests. Please try again later.", 429, "RATE_LIMITED");
    }

    const body = await req.json().catch(() => null);
    const parsed = resendSchema.safeParse(body);
    if (!parsed.success) {
      // Same generic response shape as success — no enumeration signal.
      return Response.json({
        ok: true,
        message: "If that email needs verification, we have sent a link.",
      });
    }
    const { email } = parsed.data;

    const emailRl = await checkRateLimit(
      `resend-verify-email:${email.toLowerCase()}`,
      3,
      60 * 60 * 1000,
    );
    if (!emailRl.allowed) {
      return Response.json({
        ok: true,
        message: "If that email needs verification, we have sent a link.",
      });
    }

    const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (user && !user.emailVerified && user.status === "ACTIVE") {
      const token = await issueSecurityToken(user.id, "EMAIL_VERIFICATION");
      const delivered = await sendVerificationEmail(email, token);
      await logAudit({
        req,
        hotelId: user.hotelId,
        userId: user.id,
        action: AUDIT_ACTIONS.EMAIL_VERIFICATION_SENT,
        entityType: "user",
        entityId: user.id,
        metadata: { resent: true, delivered: delivered.ok },
      });
    }

    return Response.json({
      ok: true,
      message: "If that email needs verification, we have sent a link.",
    });
  } catch (err) {
    return serverError(err, "We could not process your request right now. Please try again.");
  }
}

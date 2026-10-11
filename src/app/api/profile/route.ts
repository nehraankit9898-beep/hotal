import { db } from "@/lib/db";
import { hashPasswordAsync, verifyPasswordAsync } from "@/lib/auth";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { parseWith, profileUpdateSchema } from "@/lib/validation";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { requestIp } from "@/lib/login-security";

/**
 * PATCH /api/profile — update own name / change password (verifies current password).
 * Phase 9: a password change bumps tokenVersion — every other session for the
 * account is revoked. Phase 2: clears mustChangePassword, unlocking the session.
 */
export async function PATCH(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const { userId } = auth.user;

    const body = await readJson(req);
    const parsed = parseWith(profileUpdateSchema, body);
    if (!parsed.ok || !parsed.data) return jsonError(parsed.error ?? "Invalid request.");
    const { name, currentPassword, newPassword } = parsed.data;

    const dbUser = await db.user.findUnique({ where: { id: userId } });
    if (!dbUser) return jsonError("Account not found.", 404, "NOT_FOUND");

    const data: Record<string, unknown> = {};
    let passwordChanged = false;

    if (name !== undefined) {
      data.name = name;
    }

    if (newPassword !== undefined) {
      // When the flag forces a change, the "current password" may be the
      // temporary bootstrap/invitation secret — it must still be verified.
      if (
        currentPassword === undefined ||
        !(await verifyPasswordAsync(currentPassword, dbUser.passwordHash))
      ) {
        return jsonError("Your current password is incorrect.", 403, "WRONG_PASSWORD");
      }
      data.passwordHash = await hashPasswordAsync(newPassword);
      data.mustChangePassword = false;
      data.tokenVersion = { increment: 1 }; // revoke all other sessions
      passwordChanged = true;
    }

    if (Object.keys(data).length === 0) return jsonError("Nothing to update.");

    const updated = await db.user.update({ where: { id: userId }, data });

    await logAudit({
      req,
      hotelId: dbUser.hotelId,
      userId,
      action: passwordChanged ? AUDIT_ACTIONS.PASSWORD_CHANGED : AUDIT_ACTIONS.PROFILE_UPDATED,
      entityType: "user",
      entityId: userId,
      metadata: passwordChanged ? { fields: ["password"] } : { fields: ["name"] },
      ipAddress: requestIp(req),
    });

    return Response.json({
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        mustChangePassword: updated.mustChangePassword,
      },
      message: passwordChanged
        ? "Password updated. Other sessions have been signed out."
        : "Profile updated.",
    });
  } catch (err) {
    return serverError(err, "Profile could not be updated. Please try again.");
  }
}

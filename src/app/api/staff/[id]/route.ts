import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { issueActivationToken } from "@/lib/super-admin";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { withHotelWriteLock } from "@/lib/saas/limits";
import { canActOnStaffTarget } from "@/lib/staff-guards";

type Ctx = { params: Promise<{ id: string }> };

/** Internal rollback signal for the last-admin guard (never escapes the route). */
class LastAdminRollback extends Error {}

const ASSIGNABLE_ROLES = [
  "HOTEL_ADMIN",
  "HOTEL_MANAGER",
  "MARKETING_MANAGER",
  "RESTAURANT_MANAGER",
  "FRONT_DESK",
  "HOTEL_STAFF",
  "CASHIER",
  "KITCHEN_STAFF",
  "WAITER",
] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/**
 * PATCH /api/staff/[id] — staff account lifecycle:
 *   { role }            — change role (audited, before/after recorded)
 *   { deactivate: true } — set SUSPENDED + revoke sessions (tokenVersion++)
 *   { reactivate: true } — back to ACTIVE
 *   { revokeSessions: true } — bump tokenVersion (all sessions die)
 *   { resetInvite: true } — re-issue the one-time invitation (PENDING only)
 *
 * Protections (server-side):
 *   - last active OWNER/ADMIN safeguard: the final owner/admin account cannot
 *     be deactivated or demoted (lockout protection).
 *   - self-modification of role/deactivation is refused (self-escalation or
 *     self-lockout are both operational hazards).
 *   - every change writes an audit row with before/after.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "STAFF_MANAGE");
    if (denied) return denied;
    const hotelId = auth.user.hotelId;
    const { id } = await ctx.params;

    const user = await db.user.findFirst({
      where: { id, hotelId },
      select: { id: true, name: true, email: true, role: true, status: true },
    });
    if (!user) return jsonError("Staff member not found.", 404, "NOT_FOUND");
    // AUDIT FIX (SEC-001): an admin may not act on the owner account (suspend,
    // demote, revoke sessions, re-invite). Only the owner may.
    if (!canActOnStaffTarget(auth.user.role, user.role)) {
      return jsonError("Only the account owner can change the owner account.", 403, "FORBIDDEN");
    }

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    // ---- Guards --------------------------------------------------------
    if (user.id === auth.user.userId && (body.role !== undefined || body.deactivate === true)) {
      return jsonError(
        "You cannot change your own role or deactivate your own account.",
        403,
        "FORBIDDEN",
      );
    }

    const isAdminRole = (r: unknown) => r === "HOTEL_OWNER" || r === "HOTEL_ADMIN";
    const losingAdmin =
      (body.role !== undefined && !isAdminRole(body.role) && isAdminRole(user.role)) ||
      body.deactivate === true;

    // BUG-8 (last-admin TOCTOU): two PARALLEL demotions each counted the other
    // as "still remaining" and BOTH succeeded → the hotel was left with zero
    // admins (full owner lockout). The guard count and the mutation now run
    // inside ONE per-hotel write-locked transaction — the second demotion
    // re-reads the committed state and is rejected with 409 LAST_ADMIN.
    const roleUpdate =
      typeof body.role === "string" ? (body.role as AssignableRole) : undefined;
    if (roleUpdate !== undefined) {
      if (!ASSIGNABLE_ROLES.includes(roleUpdate)) {
        return jsonError(`Role must be one of: ${ASSIGNABLE_ROLES.join(", ")}.`);
      }
      if (roleUpdate === "HOTEL_ADMIN" && !["HOTEL_OWNER", "HOTEL_ADMIN"].includes(auth.user.role)) {
        return jsonError("Only the owner or an admin can grant admin access.", 403, "FORBIDDEN");
      }
    }

    if (losingAdmin && isAdminRole(user.role)) {
      type GuardOutcome = "OK" | "LAST_ADMIN" | "NOT_FOUND" | "ALREADY_CHANGED";
      let outcome: GuardOutcome;
      try {
        outcome = await withHotelWriteLock(hotelId, async (tx): Promise<GuardOutcome> => {
          // Re-read inside the lock (fresh, serialized state).
          const target = await tx.user.findFirst({
            where: { id: user.id, hotelId },
            select: { role: true, status: true },
          });
          if (!target) return "NOT_FOUND";
          if (!isAdminRole(target.role)) return "ALREADY_CHANGED";
          if (roleUpdate !== undefined) {
            await tx.user.update({ where: { id: user.id }, data: { role: roleUpdate } });
          } else if (body.deactivate === true) {
            await tx.user.update({
              where: { id: user.id },
              data: { status: "SUSPENDED", tokenVersion: { increment: 1 } },
            });
          }
          const remainingAdmins = await tx.user.count({
            where: {
              hotelId,
              role: { in: ["HOTEL_OWNER", "HOTEL_ADMIN"] },
              status: "ACTIVE",
              id: { not: user.id },
            },
          });
          if (remainingAdmins === 0) {
            // Throwing INSIDE the transaction rolls the demotion/deactivation
            // back atomically — no window where the last admin is mutated.
            throw new LastAdminRollback();
          }
          return "OK";
        });
      } catch (err) {
        if (err instanceof LastAdminRollback) outcome = "LAST_ADMIN";
        else throw err;
      }

      if (outcome === "NOT_FOUND") return jsonError("Staff member not found.", 404, "NOT_FOUND");
      if (outcome === "LAST_ADMIN") {
        return jsonError(
          "This is the last owner/admin account — promote another admin before changing it.",
          409,
          "LAST_ADMIN",
        );
      }
      if (outcome === "ALREADY_CHANGED") {
        return jsonError(
          "This staff member was just changed by someone else. Refresh and retry.",
          409,
          "VERSION_CONFLICT",
        );
      }
      // outcome === "OK": the locked mutation already committed.
      if (roleUpdate !== undefined) {
        await logAudit({
          req,
          hotelId,
          userId: auth.user.userId,
          action: AUDIT_ACTIONS.STAFF_ROLE_CHANGED,
          entityType: "user",
          entityId: id,
          metadata: { from: user.role, to: roleUpdate, email: user.email },
        });
        return Response.json({ ok: true, role: roleUpdate });
      }
      await logAudit({
        req,
        hotelId,
        userId: auth.user.userId,
        action: AUDIT_ACTIONS.STAFF_DEACTIVATED,
        entityType: "user",
        entityId: id,
        metadata: { email: user.email },
      });
      return Response.json({ ok: true, deactivated: true });
    }

    // ---- Actions -------------------------------------------------------
    if (roleUpdate !== undefined) {
      // Non-admin-loss role change (e.g. WAITER → CASHIER): plain update.
      await db.user.update({ where: { id }, data: { role: roleUpdate } });
      await logAudit({
        req,
        hotelId,
        userId: auth.user.userId,
        action: AUDIT_ACTIONS.STAFF_ROLE_CHANGED,
        entityType: "user",
        entityId: id,
        metadata: { from: user.role, to: roleUpdate, email: user.email },
      });
      return Response.json({ ok: true, role: roleUpdate });
    }

    if (body.deactivate === true) {
      // Non-admin target (the admin path above handled losing admins).
      await db.user.update({
        where: { id },
        data: { status: "SUSPENDED", tokenVersion: { increment: 1 } },
      });
      await logAudit({
        req,
        hotelId,
        userId: auth.user.userId,
        action: AUDIT_ACTIONS.STAFF_DEACTIVATED,
        entityType: "user",
        entityId: id,
        metadata: { email: user.email },
      });
      return Response.json({ ok: true, deactivated: true });
    }

    if (body.reactivate === true) {
      // D16: reactivation consumes a seat like any other staff account —
      // enforce the plan limit atomically (ACTIVE + PENDING count).
      const hotel = await db.hotel.findUnique({
        where: { id: hotelId },
        select: { plan: { select: { staffLimit: true } } },
      });
      const staffLimit = hotel?.plan?.staffLimit ?? 0;
      const reactivated = await withHotelWriteLock(hotelId, async (tx) => {
        if (staffLimit > 0) {
          const used = await tx.user.count({
            where: { hotelId, status: { in: ["ACTIVE", "PENDING"] } },
          });
          if (used >= staffLimit) return null;
        }
        await tx.user.update({ where: { id }, data: { status: "ACTIVE" } });
        return true;
      });
      if (!reactivated) {
        return jsonError(
          `Your plan allows up to ${staffLimit} staff accounts (active + pending). Deactivate an unused account or upgrade your plan.`,
          403,
          "SUBSCRIPTION_LIMIT_REACHED",
        );
      }
      await logAudit({
        req,
        hotelId,
        userId: auth.user.userId,
        action: AUDIT_ACTIONS.STAFF_DEACTIVATED,
        entityType: "user",
        entityId: id,
        metadata: { email: user.email, reactivated: true },
      });
      return Response.json({ ok: true, reactivated: true });
    }

    if (body.revokeSessions === true) {
      await db.user.update({ where: { id }, data: { tokenVersion: { increment: 1 } } });
      await logAudit({
        req,
        hotelId,
        userId: auth.user.userId,
        action: AUDIT_ACTIONS.STAFF_SESSIONS_REVOKED,
        entityType: "user",
        entityId: id,
        metadata: { email: user.email },
      });
      return Response.json({ ok: true, sessionsRevoked: true });
    }

    if (body.resetInvite === true) {
      if (user.status !== "PENDING") {
        return jsonError("This account is already activated — send a password reset instead.");
      }
      // Medium fix: invalidate ALL previous unused invitation tokens — the old
      // code minted a new token while every earlier 72h link stayed live.
      await db.activationToken.deleteMany({
        where: { userId: id, purpose: "OWNER_INVITATION", usedAt: null },
      });
      const { token } = await issueActivationToken(id, "OWNER_INVITATION");
      const origin = new URL(req.url).origin;
      const inviteUrl = `${origin}/activate?token=${encodeURIComponent(token)}`;
      await logAudit({
        req,
        hotelId,
        userId: auth.user.userId,
        action: AUDIT_ACTIONS.STAFF_INVITE_RESET,
        entityType: "user",
        entityId: id,
        metadata: { email: user.email },
      });
      return Response.json({ ok: true, invitation: { url: inviteUrl, expiresInHours: 72 } });
    }

    return jsonError("Nothing to do. Send { role } or { deactivate|reactivate|revokeSessions|resetInvite: true }.");
  } catch (err) {
    return serverError(err, "The staff account could not be updated.");
  }
}

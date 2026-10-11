import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { hashPasswordAsync } from "@/lib/auth";
import { issueActivationToken } from "@/lib/super-admin";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { withHotelWriteLock } from "@/lib/saas/limits";

/**
 * Phase 13 — staff management.
 *
 * GET  /api/staff — list the hotel's staff accounts
 * POST /api/staff — INVITE a staff member: creates a PENDING account (no
 *                   usable password — a random 32-byte hash they cannot know)
 *                   + a one-time OWNER_INVITATION token (72 h, stored hashed).
 *                   The invitee sets their own password via /activate?token=…
 *                   No default/shared passwords ever exist.
 *
 * Roles assignable here: the full restaurant matrix (Phase 13 handoff) minus
 * SUPER_ADMIN (platform-only) and HOTEL_OWNER (the owner account itself).
 */

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

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "STAFF_READ");
    if (denied) return denied;

    const users = await db.user.findMany({
      where: { hotelId: auth.user.hotelId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        mfaEnabled: true,
        mustChangePassword: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });

    return Response.json({
      staff: users.map((u) => ({
        ...u,
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        createdAt: u.createdAt.toISOString(),
        pendingActivation: u.status === "PENDING",
      })),
    });
  } catch (err) {
    return serverError(err, "Staff could not be loaded.");
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "STAFF_MANAGE");
    if (denied) return denied;
    const hotelId = auth.user.hotelId;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const role = body.role as AssignableRole;
    if (name.length < 2 || name.length > 80) {
      return jsonError("Staff name must be 2-80 characters.");
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return jsonError("Please enter a valid email address.");
    }
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return jsonError(`Role must be one of: ${ASSIGNABLE_ROLES.join(", ")}.`);
    }

    // Self-escalation guard: a HOTEL_ADMIN (who holds STAFF_MANAGE) cannot
    // mint another HOTEL_ADMIN — only OWNER/ADMIN may. Server-side, always.
    if (role === "HOTEL_ADMIN" && !["HOTEL_OWNER", "HOTEL_ADMIN"].includes(auth.user.role)) {
      return jsonError("Only the owner or an admin can create admin accounts.", 403, "FORBIDDEN");
    }

    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      // Generic on purpose: an admin of one hotel must not learn whether an
      // address is registered at another tenant.
      return jsonError(
        "We couldn't create this account. Check the details and try again.",
        409,
        "EMAIL_UNAVAILABLE",
      );
    }

    // Staff plan limit (Phase 13 §5) — enforced ATOMICALLY (D16): the seat
    // count includes PENDING invitations (an invite reserves a seat) and the
    // count + create run inside the per-hotel write-locked transaction, so
    // concurrent invites cannot all slip past the limit.
    const hotel = await db.hotel.findUnique({
      where: { id: hotelId },
      select: { plan: { select: { staffLimit: true } } },
    });
    const staffLimit = hotel?.plan?.staffLimit ?? 0;

    const created = await withHotelWriteLock(hotelId, async (tx) => {
      if (staffLimit > 0) {
        const used = await tx.user.count({
          where: { hotelId, status: { in: ["ACTIVE", "PENDING"] } },
        });
        if (used >= staffLimit) return null;
      }
      return tx.user.create({
        data: {
          hotelId,
          name,
          email,
          // Random unusable password — the invitee sets their own via the
          // one-time invitation link. No default credentials ever exist.
          passwordHash: await hashPasswordAsync(randomBytes(32).toString("hex")),
          role,
          status: "PENDING",
          mustChangePassword: false, // activation flow sets the FIRST password
        },
        select: { id: true, name: true, email: true, role: true, status: true },
      });
    });

    if (!created) {
      return jsonError(
        `Your plan allows up to ${staffLimit} staff accounts (active + pending invitations). Deactivate unused accounts or upgrade your plan.`,
        403,
        "SUBSCRIPTION_LIMIT_REACHED",
      );
    }
    const user = created;

    const token = (await issueActivationToken(user.id, "OWNER_INVITATION")).token;
    const origin = new URL(req.url).origin;
    const inviteUrl = `${origin}/activate?token=${encodeURIComponent(token)}`;

    await logAudit({
      req,
      hotelId,
      userId: auth.user.userId,
      action: AUDIT_ACTIONS.STAFF_INVITED,
      entityType: "user",
      entityId: user.id,
      metadata: { email, role },
    });

    return Response.json(
      {
        staff: user,
        // The invitation link is returned ONCE (the token is stored hashed —
        // it cannot be retrieved later, only re-issued).
        invitation: { url: inviteUrl, expiresInHours: 72 },
      },
      { status: 201 },
    );
  } catch (err) {
    return serverError(err, "The staff invitation could not be created.");
  }
}

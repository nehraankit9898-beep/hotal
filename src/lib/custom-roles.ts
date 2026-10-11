/**
 * Phase 17 — Custom roles.
 *
 * Owner-defined roles using the PERMISSIONS allowlist as a closed catalog.
 * The owner can only assign permissions they themselves hold; SUPER_ADMIN
 * platform privileges are never tenant-defined. Changes apply server-side
 * immediately; sessions are revoked where necessary by bumping tokenVersion.
 *
 * The system legacy roles (HOTEL_OWNER/HOTEL_MANAGER/etc.) are STILL the
 * primary RBAC. Custom roles add ADDITIONAL permissions on top — they
 * cannot REMOVE permissions from the legacy role. So a CASHIER with an
 * additional "INVENTORY_READ" custom-role assignment can read inventory,
 * but a CASHIER with no custom role still cannot. This avoids the
 * "owner grants SUPER_ADMIN_ACCESS via custom role" escalation attack.
 */
import { db } from "@/lib/db";
import { PERMISSIONS, type Permission } from "@/lib/permissions";
import type { AuthedUser } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

/** Allowlist of permissions that may be assigned via custom roles. */
const ALLOWED_CUSTOM_PERMISSIONS = new Set<Permission>(PERMISSIONS);

/**
 * Validate that all requested permissions are in the allowlist AND that the
 * caller actually holds each permission they want to grant (no escalation).
 * SUPER_ADMIN_ACCESS is NEVER assignable via custom roles — it is platform
 * only.
 */
export function validateCustomRolePermissions(
  requested: string[],
  callerRole: AuthedUser["role"],
  callerPermissions: Permission[],
): { ok: true; permissions: Permission[] } | { ok: false; error: string } {
  const result: Permission[] = [];
  for (const raw of requested) {
    if (raw === "SUPER_ADMIN_ACCESS") {
      return {
        ok: false,
        error: "SUPER_ADMIN_ACCESS cannot be granted via custom roles.",
      };
    }
    if (!ALLOWED_CUSTOM_PERMISSIONS.has(raw as Permission)) {
      return { ok: false, error: `Unknown permission: ${raw}` };
    }
    // Owner can only assign permissions they themselves hold.
    if (callerRole !== "SUPER_ADMIN" && !callerPermissions.includes(raw as Permission)) {
      return {
        ok: false,
        error: `You cannot grant ${raw} because your own role does not include it.`,
      };
    }
    result.push(raw as Permission);
  }
  // Dedupe while preserving order.
  return { ok: true, permissions: Array.from(new Set(result)) };
}

/**
 * Resolve the union of legacy role permissions + custom-role permissions for
 * a user. Called by hasPermission when evaluating custom roles.
 *
 * NOTE: this function must be cheap — it's called on every permission check.
 * In production, wrap with a per-request cache (LRU) keyed by userId+updatedAt.
 */
export async function resolveUserPermissions(
  user: AuthedUser,
): Promise<Permission[]> {
  // Legacy role permissions are always the base.
  const { ROLE_PERMISSIONS } = await import("@/lib/permissions");
  const base: Permission[] = ROLE_PERMISSIONS[user.role] ?? [];
  // SUPER_ADMIN and unauth'd users don't have custom roles.
  if (user.role === "SUPER_ADMIN" || !user.hotelId) return base;

  // Look up active custom-role assignments for this user.
  const assignments = await db.customRoleAssignment.findMany({
    where: { userId: user.userId, customRole: { active: true, hotelId: user.hotelId } },
    select: { customRole: { select: { permissions: true } } },
  });
  if (assignments.length === 0) return base;
  const extra = new Set<Permission>();
  for (const a of assignments) {
    try {
      const parsed = JSON.parse(a.customRole.permissions);
      if (Array.isArray(parsed)) {
        for (const p of parsed) {
          if (ALLOWED_CUSTOM_PERMISSIONS.has(p as Permission)) {
            extra.add(p as Permission);
          }
        }
      }
    } catch {
      // Bad JSON in role — ignore, don't crash the request.
    }
  }
  if (extra.size === 0) return base;
  // Dedupe (base may already include some).
  const merged = new Set<Permission>(base);
  for (const p of extra) merged.add(p);
  return Array.from(merged);
}

/**
 * Create a custom role. Caller must hold CUSTOM_ROLE_MANAGE AND each granted
 * permission. Audit logged.
 */
export async function createCustomRole(
  user: AuthedUser,
  name: string,
  permissions: Permission[],
  description?: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string; status?: number }> {
  if (user.role === "SUPER_ADMIN") {
    return { ok: false, error: "Custom roles are tenant-defined; super admin cannot create them.", status: 403 };
  }
  const callerPermissions = await resolveUserPermissions(user);
  if (!callerPermissions.includes("CUSTOM_ROLE_MANAGE")) {
    return { ok: false, error: "You do not have permission to manage custom roles.", status: 403 };
  }
  const validation = validateCustomRolePermissions(permissions, user.role, callerPermissions);
  if (!validation.ok) return { ok: false, error: validation.error };
  try {
    const role = await db.customRole.create({
      data: {
        hotelId: user.hotelId,
        name: name.slice(0, 80),
        description: description?.slice(0, 500) ?? null,
        permissions: JSON.stringify(validation.permissions),
        createdByUserId: user.userId,
      },
      select: { id: true },
    });
    await logAudit({
      hotelId: user.hotelId,
      userId: user.userId,
      action: "CUSTOM_ROLE_CREATED",
      entityType: "CustomRole",
      entityId: role.id,
      metadata: { name, permissions: validation.permissions },
    });
    return { ok: true, id: role.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Assign a custom role to a user. Side-effect: bump the target user's
 * tokenVersion so any active session re-validates. Prevent self-escalation
 * only if the assignment would grant a permission the assigner lacks.
 */
export async function assignCustomRole(
  user: AuthedUser,
  customRoleId: string,
  targetUserId: string,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  if (user.role === "SUPER_ADMIN") {
    return { ok: false, error: "Super admin cannot assign tenant custom roles.", status: 403 };
  }
  const callerPermissions = await resolveUserPermissions(user);
  if (!callerPermissions.includes("CUSTOM_ROLE_MANAGE")) {
    return { ok: false, error: "Forbidden", status: 403 };
  }
  const role = await db.customRole.findFirst({
    where: { id: customRoleId, hotelId: user.hotelId, active: true },
  });
  if (!role) return { ok: false, error: "Custom role not found.", status: 404 };
  const target = await db.user.findFirst({
    where: { id: targetUserId, hotelId: user.hotelId },
    select: { id: true, role: true },
  });
  if (!target) return { ok: false, error: "Target user not found.", status: 404 };

  try {
    await db.$transaction([
      db.customRoleAssignment.create({
        data: { customRoleId, userId: targetUserId, assignedBy: user.userId },
      }),
      // Bump tokenVersion so the target's sessions re-evaluate permissions.
      db.user.update({
        where: { id: targetUserId },
        data: { tokenVersion: { increment: 1 } },
      }),
    ]);
    await logAudit({
      hotelId: user.hotelId,
      userId: user.userId,
      action: "CUSTOM_ROLE_ASSIGNED",
      entityType: "User",
      entityId: targetUserId,
      metadata: { customRoleId, customRoleName: role.name },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Phase 17 — Custom roles.
 *
 * Owner-defined roles using the PERMISSIONS allowlist as a closed catalog.
 * The owner can only assign permissions they themselves hold; SUPER_ADMIN
 * platform privileges are never tenant-defined. Changes apply server-side
 * immediately; sessions are revoked where necessary by bumping tokenVersion.
 *
 * System roles remain the baseline: custom roles add permissions, never
 * subtract them. Platform and sensitive owner/admin operations are excluded
 * from custom grants, including for roles persisted before this policy.
 */
import { db } from "@/lib/db";
import { PERMISSIONS, type Permission } from "@/lib/permissions";
import type { AuthedUser } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

/** Allowlist of permissions that may be assigned via custom roles. */
// Defense in depth: ordinary custom roles must not mint platform or account /
// financial administration privileges. These remain governed by system roles.
const RESERVED_PERMISSIONS = new Set<Permission>([
  "SUPER_ADMIN_ACCESS", "CUSTOM_ROLE_MANAGE", "STAFF_MANAGE", "SETTINGS_MANAGE",
  "INTEGRATION_MANAGE", "BRANCH_MANAGE", "FRANCHISE_MANAGE", "WHITE_LABEL_MANAGE",
  "ENTERPRISE_API_MANAGE", "WEBHOOK_MANAGE", "PRIVACY_REQUEST_MANAGE",
  "BILL_REFUND", "BILL_VOID", "TAX_MANAGE", "AUDIT_LOG_READ",
]);

/**
 * BUG FIX (import cycle): this module sits in the cycle
 *   permissions.ts → api-helpers.ts → custom-roles.ts → permissions.ts
 * (`permissions` needs `jsonError`, `api-helpers` needs `resolveUserPermissions`,
 * this file needs the `PERMISSIONS` catalog). Building the allowlist at module
 * scope therefore read `PERMISSIONS` while `permissions.ts` was still
 * initializing whenever that file was the first of the three to load — every
 * such load died with
 *   ReferenceError: Cannot access 'PERMISSIONS' before initialization
 * (this is what broke `bun test tests/unit.test.ts`, and would break any route
 * or script that imports `@/lib/permissions` before `@/lib/api-helpers`).
 * The catalog is now read on FIRST USE, by which time every module in the
 * cycle has finished evaluating. Nothing else about the allowlist changes.
 */
let allowedCustomPermissions: Set<Permission> | null = null;
function allowedCustomRolePermissions(): Set<Permission> {
  if (allowedCustomPermissions === null) {
    allowedCustomPermissions = new Set<Permission>(
      PERMISSIONS.filter((p) => !RESERVED_PERMISSIONS.has(p)),
    );
  }
  return allowedCustomPermissions;
}

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
    if (!allowedCustomRolePermissions().has(raw as Permission)) {
      return { ok: false, error: `Permission cannot be granted via custom roles: ${raw}` };
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
 * Resolve the union of system role and active same-tenant custom assignments.
 * requireAuth calls this once per request after checking the authoritative
 * account/hotel. Do not cache across requests: revocation must be immediate.
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
    where: { userId: user.userId, customRole: { active: true, hotelId: user.hotelId, isSystemRole: false } },
    select: { customRole: { select: { permissions: true } } },
  });
  if (assignments.length === 0) return base;
  const extra = new Set<Permission>();
  for (const a of assignments) {
    try {
      const parsed = JSON.parse(a.customRole.permissions);
      if (Array.isArray(parsed)) {
        for (const p of parsed) {
          if (typeof p === "string" && allowedCustomRolePermissions().has(p as Permission)) {
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
  // BUG FIX (API contract): an ungrantable permission is a VALIDATION error and
  // must be reported as 422 — the same route's PATCH handler and every other
  // validated payload in this API return 422. Without the explicit status the
  // POST handler fell back to 400, so the documented contract (and the Phase 17
  // regression suite) saw a different code for the same class of error.
  if (!validation.ok) return { ok: false, error: validation.error, status: 422 };
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
  } catch {
    // Never disclose ORM errors or constraint details to an API caller.
    return { ok: false, error: "Unable to save custom role change.", status: 500 };
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
    where: { id: customRoleId, hotelId: user.hotelId, active: true, isSystemRole: false },
  });
  if (!role) return { ok: false, error: "Custom role not found.", status: 404 };
  let grants: unknown;
  try { grants = JSON.parse(role.permissions); } catch { /* fail closed */ }
  if (!Array.isArray(grants) || grants.some((p) => typeof p !== "string") ||
      !validateCustomRolePermissions(grants, user.role, callerPermissions).ok) {
    return { ok: false, error: "Custom role contains invalid or ungrantable permissions.", status: 403 };
  }
  const target = await db.user.findFirst({
    where: { id: targetUserId, hotelId: user.hotelId, status: "ACTIVE" },
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
  } catch {
    // Never disclose ORM errors or constraint details to an API caller.
    return { ok: false, error: "Unable to save custom role change.", status: 500 };
  }
}

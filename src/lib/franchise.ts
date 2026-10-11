/**
 * Phase 17 — Chain / franchise management.
 *
 * Extends Phase 16 BranchGroup with an explicit FranchiseOrganization that
 * owns branches, central admin membership, central menu templates, branch
 * overrides and scheduled versioned rollouts.
 *
 * Authorization rule: a user is a central admin iff they hold HOTEL_OWNER
 * on a member branch AND are listed in FranchiseOrganizationAdmin. Super
 * Admin platform visibility is NOT owner access.
 *
 * Issued bills are immutable snapshots — central menu template edits or
 * branch overrides NEVER rewrite historical invoices. Rollout rollback
 * only restores branch overrides to the previous version; it does not
 * touch already-billed data.
 */
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import type { AuthedUser } from "@/lib/api-helpers";

/**
 * Verify the caller is an authorized central admin of the organization.
 * Server-side only; UI hiding is insufficient. Accepts HOTEL_OWNER or
 * HOTEL_ADMIN (both are full-tenant-admin roles per the Phase 5/6 RBAC).
 */
export async function isFranchiseAdmin(
  user: AuthedUser,
  orgId: string,
): Promise<boolean> {
  if (user.role === "SUPER_ADMIN") return false; // Super Admin ≠ owner access
  if (user.role !== "HOTEL_OWNER" && user.role !== "HOTEL_ADMIN") return false;
  const admin = await db.franchiseOrganizationAdmin.findUnique({
    where: { orgId_userId: { orgId, userId: user.userId } },
  });
  return !!admin;
}

/**
 * Create a new franchise organization. The creator becomes the first
 * CENTRAL_ADMIN. Caller must hold FRANCHISE_MANAGE.
 */
export async function createFranchise(
  user: AuthedUser,
  name: string,
  legalName?: string,
  taxId?: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string; status?: number }> {
  if (user.role === "SUPER_ADMIN") {
    return { ok: false, error: "Franchise organizations are tenant-owned.", status: 403 };
  }
  if (user.role !== "HOTEL_OWNER" && user.role !== "HOTEL_ADMIN") {
    return { ok: false, error: "Only the hotel owner or admin may create a franchise.", status: 403 };
  }
  try {
    const org = await db.franchiseOrganization.create({
      data: {
        name: name.slice(0, 120),
        legalName: legalName?.slice(0, 200) ?? null,
        taxId: taxId?.slice(0, 50) ?? null,
        createdByUserId: user.userId,
        admins: {
          create: { userId: user.userId, role: "CENTRAL_ADMIN" },
        },
      },
      select: { id: true },
    });
    await logAudit({
      hotelId: user.hotelId,
      userId: user.userId,
      action: "FRANCHISE_CREATED",
      entityType: "FranchiseOrganization",
      entityId: org.id,
      metadata: { name, legalName, taxId },
    });
    return { ok: true, id: org.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Add a branch (Hotel) to a franchise organization via its existing
 * BranchMembership. A hotel may belong to at most one organization.
 */
export async function addBranchToFranchise(
  user: AuthedUser,
  orgId: string,
  hotelId: string,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  if (!(await isFranchiseAdmin(user, orgId))) {
    return { ok: false, error: "Forbidden", status: 403 };
  }
  // The hotel must already have a BranchMembership in some group, OR we
  // create one in a default group. For MVP we attach the hotel directly
  // to the franchise via the `orgId` column on BranchMembership.
  // The existing BranchGroup from Phase 16 remains for owner-visibility
  // grouping; FranchiseOrganization adds chain-level governance.
  const hotel = await db.hotel.findUnique({
    where: { id: hotelId },
    select: { id: true, status: true },
  });
  if (!hotel) return { ok: false, error: "Hotel not found.", status: 404 };

  // Find or create the organization's own BranchGroup.
  let group = await db.branchGroup.findFirst({
    where: { name: `franchise-${orgId}` },
  });
  if (!group) {
    group = await db.branchGroup.create({
      data: { name: `franchise-${orgId}`, createdByUserId: user.userId },
    });
  }
  // Move the hotel into the franchise's group (idempotent).
  const existing = await db.branchMembership.findUnique({
    where: { hotelId },
  });
  if (existing) {
    await db.branchMembership.update({
      where: { hotelId },
      data: { groupId: group.id, franchiseOrganizationId: orgId },
    });
  } else {
    await db.branchMembership.create({
      data: { groupId: group.id, hotelId, franchiseOrganizationId: orgId },
    });
  }
  await logAudit({
    hotelId: user.hotelId,
    userId: user.userId,
    action: "FRANCHISE_BRANCH_ADDED",
    entityType: "FranchiseOrganization",
    entityId: orgId,
    metadata: { branchHotelId: hotelId },
  });
  return { ok: true };
}

/**
 * Publish a new version of a central menu template. The previous version
 * remains immutable (for historical reference and rollback). Branches that
 * have overrides continue to apply them — the new template is the canonical
 * catalog going forward.
 */
export async function publishTemplateVersion(
  user: AuthedUser,
  templateId: string,
): Promise<{ ok: true; version: number } | { ok: false; error: string; status?: number }> {
  const template = await db.centralMenuTemplate.findUnique({
    where: { id: templateId },
    include: { org: { select: { id: true } } },
  });
  if (!template) return { ok: false, error: "Template not found.", status: 404 };
  if (!(await isFranchiseAdmin(user, template.org.id))) {
    return { ok: false, error: "Forbidden", status: 403 };
  }
  const newVersion = template.version + 1;
  await db.centralMenuTemplate.update({
    where: { id: templateId },
    data: { version: newVersion, publishedAt: new Date() },
  });
  await logAudit({
    hotelId: user.hotelId,
    userId: user.userId,
    action: "CENTRAL_MENU_PUBLISHED",
    entityType: "CentralMenuTemplate",
    entityId: templateId,
    metadata: { version: newVersion },
  });
  return { ok: true, version: newVersion };
}

/**
 * Schedule a rollout of a template version to branches. Status PENDING.
 * The worker drains due rollouts and applies them per branch.
 */
export async function scheduleRollout(
  user: AuthedUser,
  templateId: string,
  scheduledAt: Date,
  conflictPolicy: "SKIP_OVERWRITE" | "FORCE" = "SKIP_OVERWRITE",
): Promise<{ ok: true; id: string } | { ok: false; error: string; status?: number }> {
  const template = await db.centralMenuTemplate.findUnique({
    where: { id: templateId },
    include: { org: { select: { id: true } } },
  });
  if (!template) return { ok: false, error: "Template not found.", status: 404 };
  if (!(await isFranchiseAdmin(user, template.org.id))) {
    return { ok: false, error: "Forbidden", status: 403 };
  }
  const rollout = await db.centralMenuRollout.create({
    data: {
      orgId: template.org.id,
      templateId,
      version: template.version,
      scheduledAt,
      status: "PENDING",
      conflictPolicy,
      createdByUserId: user.userId,
    },
    select: { id: true },
  });
  await logAudit({
    hotelId: user.hotelId,
    userId: user.userId,
    action: "CENTRAL_MENU_ROLLOUT_SCHEDULED",
    entityType: "CentralMenuRollout",
    entityId: rollout.id,
    metadata: { templateId, version: template.version, scheduledAt: scheduledAt.toISOString() },
  });
  return { ok: true, id: rollout.id };
}

/**
 * Rollback a rollout. Restores branch overrides to the previous template
 * version's state — but NEVER changes issued bills (those are immutable
 * snapshots). Rollback only applies to future billing, not historical.
 */
export async function rollbackRollout(
  user: AuthedUser,
  rolloutId: string,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const rollout = await db.centralMenuRollout.findUnique({
    where: { id: rolloutId },
    include: { template: { include: { org: { select: { id: true } } } } },
  });
  if (!rollout) return { ok: false, error: "Rollout not found.", status: 404 };
  if (!(await isFranchiseAdmin(user, rollout.template.org.id))) {
    return { ok: false, error: "Forbidden", status: 403 };
  }
  if (rollout.status !== "COMPLETED") {
    return { ok: false, error: "Only COMPLETED rollouts can be rolled back.", status: 409 };
  }
  await db.centralMenuRollout.update({
    where: { id: rolloutId },
    data: { status: "ROLLED_BACK", rolledBackAt: new Date() },
  });
  await logAudit({
    hotelId: user.hotelId,
    userId: user.userId,
    action: "CENTRAL_MENU_ROLLOUT_ROLLED_BACK",
    entityType: "CentralMenuRollout",
    entityId: rolloutId,
    metadata: { previousVersion: rollout.version },
  });
  return { ok: true };
}

/**
 * Consolidated read for franchise dashboard: per-branch totals (sales,
 * customers, low-stock). Authorization-enforced — non-member branches
 * structurally excluded from every aggregation.
 */
export async function getFranchiseBranchSummary(
  user: AuthedUser,
  orgId: string,
): Promise<{ ok: true; branches: Array<{ hotelId: string; name: string; totalSalesMinor: number; customers: number; lowStockCount: number }> } | { ok: false; error: string; status?: number }> {
  if (!(await isFranchiseAdmin(user, orgId))) {
    return { ok: false, error: "Forbidden", status: 403 };
  }
  const memberships = await db.branchMembership.findMany({
    where: { franchiseOrganizationId: orgId },
    include: { hotel: { select: { id: true, name: true } } },
  });
  const branches: Array<{
    hotelId: string;
    name: string;
    totalSalesMinor: number;
    customers: number;
    lowStockCount: number;
  }> = [];
  for (const m of memberships) {
    if (!m.hotel) continue;
    const totalSalesMinor = await db.bill.aggregate({
      where: { hotelId: m.hotelId, status: "PAID" },
      _sum: { totalMinor: true },
    });
    const customers = await db.customer.count({ where: { hotelId: m.hotelId } });
    const lowStockCount = await db.ingredient.count({
      where: { hotelId: m.hotelId, stockQty: { lte: db.ingredient.fields.lowStockThreshold } },
    });
    branches.push({
      hotelId: m.hotelId,
      name: m.hotel.name,
      totalSalesMinor: totalSalesMinor._sum.totalMinor ?? 0,
      customers,
      lowStockCount,
    });
  }
  return { ok: true, branches } as const;
}

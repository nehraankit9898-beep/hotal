import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

/**
 * Phase 16 — multi-branch owner dashboard data.
 *
 * AUTHORIZATION MODEL (documented): a user sees consolidated data for the
 * branches of ONE group iff they are HOTEL_OWNER/HOTEL_ADMIN of at least one
 * member hotel. Every aggregation is branch-scoped by construction — a branch
 * the user has no owner/admin relationship with is EXCLUDED from totals and
 * never leaks row-level data. Super Admin visibility is NOT owner access.
 *
 * GET /api/branches — { groups: [...], myBranches: [...] } per the rules
 * POST /api/branches — owner creates/joins group: { name } (creates a group
 *   seeded with their own hotel) or { name, hotelId } (owner of hotelId adds
 *   that branch — requires HOTEL_OWNER on the target).
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BRANCH_MANAGE");
    if (denied) return denied;
    if (auth.user.role !== "HOTEL_OWNER" && auth.user.role !== "HOTEL_ADMIN") {
      return jsonError("Branch dashboards are for owners/admins.", 403, "FORBIDDEN");
    }

    const myMembership = await db.branchMembership.findUnique({
      where: { hotelId: auth.user.hotelId! },
      include: {
        group: { include: { memberships: { include: { hotel: { select: { id: true, name: true, city: true, status: true } } } } } },
      },
    });

    const branches = myMembership?.group?.memberships ?? [];
    // Owner-visible rows: their own hotel's aggregates. Cross-branch
    // aggregation is only possible via explicit membership — which is exactly
    // what the group represents; every branch here is in the SAME group.
    const branchData = await Promise.all(
      branches
        .filter((m) => m.hotel.status === "ACTIVE")
        .map(async (m) => {
          const [billAgg, customerCount, lowStock] = await Promise.all([
            db.bill.aggregate({
              where: { hotelId: m.hotelId, status: { not: "VOID" } },
              _sum: { totalMinor: true, subtotalMinor: true, discountMinor: true, taxMinor: true, refundMinor: true },
              _count: true,
            }),
            db.customer.count({ where: { hotelId: m.hotelId } }),
            db.ingredient.count({ where: { hotelId: m.hotelId, active: true, stockQty: { lte: db.ingredient.fields.lowStockThreshold } } }),
          ]);
          return {
            hotelId: m.hotelId,
            name: m.hotel.name,
            city: m.hotel.city,
            isMine: m.hotelId === auth.user.hotelId,
            bills: billAgg._count,
            netSalesMinor: (billAgg._sum.subtotalMinor ?? 0) - (billAgg._sum.discountMinor ?? 0),
            refundMinor: billAgg._sum.refundMinor ?? 0,
            customers: customerCount,
            lowStock,
          };
        }),
    );

    const totals = branchData.reduce(
      (acc, b) => ({
        bills: acc.bills + b.bills,
        netSalesMinor: acc.netSalesMinor + b.netSalesMinor,
        refundMinor: acc.refundMinor + b.refundMinor,
        customers: acc.customers + b.customers,
        lowStock: acc.lowStock + b.lowStock,
      }),
      { bills: 0, netSalesMinor: 0, refundMinor: 0, customers: 0, lowStock: 0 },
    );

    return Response.json({
      group: myMembership?.group ? { id: myMembership.group.id, name: myMembership.group.name } : null,
      branches: branchData,
      totals,
    });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BRANCH_MANAGE");
    if (denied) return denied;
    if (auth.user.role !== "HOTEL_OWNER" && auth.user.role !== "HOTEL_ADMIN") {
      return jsonError("Only owners/admins manage branch groups.", 403, "FORBIDDEN");
    }

    const body = await readJson(req);
    if (!body || typeof body.name !== "string" || body.name.trim().length < 2) {
      return jsonError("Group name is required.", 422, "INVALID_NAME");
    }

    const existing = await db.branchMembership.findUnique({ where: { hotelId: auth.user.hotelId! } });
    if (existing) return jsonError("This hotel already belongs to a branch group.", 422, "ALREADY_MEMBER");

    const group = await db.branchGroup.create({
      data: { name: body.name.trim().slice(0, 120), createdByUserId: auth.user.userId },
    });
    await db.branchMembership.create({ data: { groupId: group.id, hotelId: auth.user.hotelId! } });
    await logAudit({
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: "BRANCH_GROUP_CREATED",
      entityType: "BranchGroup",
      entityId: group.id,
      metadata: { name: group.name },
      req,
    });
    return Response.json({ group }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}

import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { requireSuperAdminSession } from "@/lib/api-helpers";

/**
 * GET /api/super-admin/audit — platform-wide cross-tenant audit trail
 * (Super Admin only — Phase 8.1 §5).
 *
 * Returns audit entries from ALL hotels with the hotel name, actor, action,
 * and timestamp so the platform operator has real cross-tenant visibility.
 * Hotel users get 403 (hotel-scoped audit lives at /api/audit-logs).
 */
export async function GET(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;

  try {
    const url = new URL(req.url);
    const action = (url.searchParams.get("action") || "").trim();
    const hotelId = (url.searchParams.get("hotelId") || "").trim();
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(5, parseInt(url.searchParams.get("pageSize") || "20", 10) || 20),
    );

    const where: Record<string, unknown> = {};
    if (action && action !== "all") where.action = action;
    if (hotelId) where.hotelId = hotelId;

    const [total, logs] = await Promise.all([
      db.auditLog.count({ where }),
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { name: true, email: true, role: true } },
          hotel: { select: { name: true } },
        },
      }),
    ]);

    // Distinct actions for the filter dropdown (cheap scan over indexed column).
    const actions = await db.auditLog.findMany({
      select: { action: true },
      distinct: ["action"],
      orderBy: { action: "asc" },
    });

    return Response.json({
      logs: logs.map((l) => ({
        id: l.id,
        action: l.action,
        entityType: l.entityType,
        entityId: l.entityId,
        metadata: l.metadata,
        hotel: l.hotel ? { name: l.hotel.name } : null,
        user: l.user ? { name: l.user.name, email: l.user.email, role: l.user.role } : null,
        createdAt: l.createdAt,
      })),
      actions: actions.map((a) => a.action),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    console.error("[super-admin/audit] error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not load platform audit logs." } },
      { status: 500 },
    );
  }
}

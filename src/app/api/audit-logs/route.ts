import { db } from "@/lib/db";
import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";

/**
 * GET /api/audit-logs — paginated audit trail (hotel-scoped). Query: action, page, pageSize
 * Phase 8.1 §3: hotel-scoped only — SUPER_ADMIN (hotelId = "") is denied here and
 * consumes the dedicated platform-wide /api/super-admin/audit endpoint instead.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    if (auth.user.role === "SUPER_ADMIN") {
      return jsonError(
        "Use the platform audit endpoint (/api/super-admin/audit).",
        403,
        "FORBIDDEN",
      );
    }
    const denied = requirePermission(auth.user, "AUDIT_LOG_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;
    if (!hotelId) return jsonError("Hotel context is required.", 403, "FORBIDDEN");

    const url = new URL(req.url);
    const action = (url.searchParams.get("action") || "").trim();
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(5, parseInt(url.searchParams.get("pageSize") || "20", 10) || 20),
    );

    const where: Record<string, unknown> = { hotelId };
    if (action && action !== "all") where.action = action;

    const [total, logs] = await Promise.all([
      db.auditLog.count({ where }),
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { name: true, email: true } } },
      }),
    ]);

    return Response.json({
      logs: logs.map((l) => ({
        id: l.id,
        action: l.action,
        entityType: l.entityType,
        entityId: l.entityId,
        metadata: l.metadata,
        user: l.user ? { name: l.user.name, email: l.user.email } : null,
        createdAt: l.createdAt,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    return serverError(err, "Could not load audit logs. Please try again.");
  }
}

import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { openCashSession } from "@/lib/billing";

/**
 * Phase 14 — cash drawer sessions.
 *
 * GET  /api/cash-sessions?open=1&limit= — list sessions (with reconciliation)
 * POST /api/cash-sessions — open a drawer { openingFloatMinor }
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CASH_SESSION_MANAGE");
    if (denied) return denied;

    const url = new URL(req.url);
    const openOnly = url.searchParams.get("open") === "1";
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 30) || 30, 100);
    const sessions = await db.cashSession.findMany({
      where: { hotelId: auth.user.hotelId, ...(openOnly ? { status: "OPEN" } : {}) },
      orderBy: { openedAt: "desc" },
      take: limit,
    });
    return Response.json({ sessions });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CASH_SESSION_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    const openingFloatMinor =
      typeof body?.openingFloatMinor === "number" && Number.isFinite(body.openingFloatMinor)
        ? Math.max(0, Math.floor(body.openingFloatMinor))
        : 0;

    const result = await openCashSession(auth.user.hotelId, auth.user.userId, openingFloatMinor);
    if (!result.ok) return jsonError(result.reason ?? "Cannot open cash session.", 422, "SESSION_OPEN_REJECTED");
    return Response.json({ session: result }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}

import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { closeCashSession } from "@/lib/billing";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/cash-sessions/[id] — close the drawer with reconciliation.
 * Body: { countedCashMinor, notes? }
 * Computes cashSales (CASH payments tagged to this session), refunds,
 * expected cash and the variance — all audited.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CASH_SESSION_MANAGE");
    if (denied) return denied;

    const { id } = await ctx.params;
    const body = await readJson(req);
    const counted = Number(body?.countedCashMinor);
    if (!Number.isFinite(counted) || Math.floor(counted) !== counted || counted < 0) {
      return jsonError("countedCashMinor must be a non-negative integer.", 422, "INVALID_AMOUNT");
    }

    const result = await closeCashSession(
      auth.user.hotelId,
      auth.user.userId,
      id,
      Math.floor(counted),
      typeof body?.notes === "string" ? body.notes.slice(0, 500) : undefined,
    );
    if (!result.ok) return jsonError(result.reason ?? "Cannot close session.", 404, "NOT_FOUND");
    return Response.json({ session: result });
  } catch (err) {
    return serverError(err);
  }
}

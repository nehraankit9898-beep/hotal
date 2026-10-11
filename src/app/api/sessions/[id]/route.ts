import { db } from "@/lib/db";
import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { closeTableSession } from "@/lib/orders";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/sessions/[id] — close the table session.
 * Body: { close: true } (explicit action, no accidental closes).
 *
 * Orders keep their tableSessionId (SetNull on delete only); closing just
 * ends the dining session — new orders need a fresh session. Operational
 * history is never deleted.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "SESSION_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;

    // Close-all confirmation for the floor view: an explicit body is required
    // so a stray PATCH never closes a table.
    const result = await closeTableSession(auth.user.hotelId, id);
    if (!result.ok) return jsonError("Open table session not found.", 404, "NOT_FOUND");
    return Response.json({ ok: true, closed: true });
  } catch (err) {
    return serverError(err, "The table session could not be closed.");
  }
}

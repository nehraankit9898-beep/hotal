import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { approveAndSend } from "@/lib/ai/recommendations";

/**
 * Phase 18 — approve ONE recommendation and send it (AI_MANAGE).
 * The approval identity is recorded; consent/quota/provider checks run at
 * send time. Honest result: simulated vs sent vs provider-failed.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AI_MANAGE");
    if (denied) return denied;

    const { id } = await ctx.params;
    const result = await approveAndSend(id, auth.user.hotelId, auth.user.userId);
    if (!result.ok) {
      return Response.json({ error: result.message }, { status: result.status });
    }
    return Response.json({
      ok: true,
      simulated: result.simulated ?? false,
      message: result.message,
    });
  } catch (err) {
    return serverError(err);
  }
}

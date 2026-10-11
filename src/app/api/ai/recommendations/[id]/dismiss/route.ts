import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { dismissRecommendation } from "@/lib/ai/recommendations";

/** Phase 18 — dismiss ONE pending recommendation (AI_MANAGE). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AI_MANAGE");
    if (denied) return denied;

    const { id } = await ctx.params;
    const ok = await dismissRecommendation(id, auth.user.hotelId, auth.user.userId);
    if (!ok) return Response.json({ error: "Pending recommendation not found." }, { status: 404 });
    return Response.json({ ok: true });
  } catch (err) {
    return serverError(err);
  }
}

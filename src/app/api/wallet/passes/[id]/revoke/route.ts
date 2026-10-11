import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { revokePass } from "@/lib/ai/wallet";

/** Phase 18 — revoke a wallet pass (AI_MANAGE). Revocation is immediate. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AI_MANAGE");
    if (denied) return denied;

    const { id } = await ctx.params;
    const ok = await revokePass(auth.user.hotelId, id);
    if (!ok) return Response.json({ error: "Active pass not found." }, { status: 404 });
    return Response.json({ ok: true, status: "REVOKED" });
  } catch (err) {
    return serverError(err);
  }
}

import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { db } from "@/lib/db";

/**
 * Phase 18 — AI governance audit trail (AI_READ).
 * GET /api/ai/interactions?limit=100 — the owner-visible log of every AI
 * decision/refusal. Contains reason codes and counters only (never raw
 * customer text, never secrets) by construction.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AI_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100), 500);
    const kind = url.searchParams.get("kind");

    const interactions = await db.aIInteractionLog.findMany({
      where: { hotelId: auth.user.hotelId, ...(kind ? { kind } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return Response.json({ interactions });
  } catch (err) {
    return serverError(err);
  }
}

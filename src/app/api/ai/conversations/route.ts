import { db } from "@/lib/db";
import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";

/**
 * Phase 18 — AI console data: chatbot conversations (AI_READ).
 *
 * GET /api/ai/conversations — list the tenant's chatbot conversations with
 * derived cart totals. Returns conversation STATE and cart snapshots (already
 * server-priced lines) — never raw inbound customer text (that is not stored
 * anywhere by design).
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AI_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50), 200);

    const conversations = await db.aIConversation.findMany({
      where: { hotelId: auth.user.hotelId },
      orderBy: { lastActivityAt: "desc" },
      take: limit,
      include: { customer: { select: { id: true, name: true } } },
    });

    return Response.json({
      conversations: conversations.map((c) => {
        let cart: Array<{ name: string; quantity: number; lineTotalMinor: number }> = [];
        let cartTotalMinor = 0;
        if (c.cartJson) {
          try {
            const parsed = JSON.parse(c.cartJson) as Array<{ name?: unknown; quantity?: unknown; lineTotalMinor?: unknown }>;
            if (Array.isArray(parsed)) {
              cart = parsed
                .filter((l) => typeof l?.name === "string" && typeof l?.quantity === "number")
                .map((l) => ({
                  name: String(l.name),
                  quantity: Number(l.quantity),
                  lineTotalMinor: Number(l.lineTotalMinor ?? 0),
                }));
              cartTotalMinor = cart.reduce((s, l) => s + (Number.isFinite(l.lineTotalMinor) ? l.lineTotalMinor : 0), 0);
            }
          } catch { /* corrupt cart → empty display */ }
        }
        return {
          id: c.id,
          phone: c.phone,
          customerId: c.customerId,
          customerName: c.customer?.name ?? null,
          state: c.state,
          cart,
          cartTotalMinor,
          lastOrderId: c.lastOrderId,
          messageCount: c.messageCount,
          lastActivityAt: c.lastActivityAt,
        };
      }),
    });
  } catch (err) {
    return serverError(err);
  }
}

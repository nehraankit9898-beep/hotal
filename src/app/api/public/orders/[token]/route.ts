import { jsonError, serverError } from "@/lib/api-helpers";
import { publicOrderTracking } from "@/lib/orders";
import { checkRateLimit } from "@/lib/rate-limit";
import { requestIp } from "@/lib/login-security";

/**
 * GET /api/public/orders/[token] — public order tracking.
 *
 * The order's publicToken (32 random chars, separate from the table session
 * token) is the diner's ONLY view capability. The response shows this
 * order's status, items and totals — never other table orders, never
 * personal data of other customers, never staff info. Foreign/guessed tokens
 * are indistinguishable from missing ones (404).
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params;

    const burst = await checkRateLimit(`public-track:${requestIp(req)}`, 120, 60 * 1000);
    if (!burst.allowed) {
      return jsonError("Too many requests. Please wait a moment.", 429, "RATE_LIMITED");
    }

    const order = await publicOrderTracking(token);
    if (!order) return jsonError("Order not found.", 404, "NOT_FOUND");

    return Response.json({ order }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return serverError(err, "The order could not be loaded.");
  }
}

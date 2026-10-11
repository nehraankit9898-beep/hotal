import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { retryFailedMessages } from "@/lib/campaigns";
import { db } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/campaigns/[id]/retry — Phase 6.4 (spec §16) message retry system.
 *
 * Re-sends FAILED messages for this campaign with:
 *  - max 3 attempts per message (MAX_RETRIES)
 *  - exponential backoff (2^attempt minutes, capped at 15)
 *  - live consent re-check before every attempt
 *  - idempotency (existing reservation is reused — no duplicate sends)
 *  - dead-letter visibility: exhausted messages are reported, not retried.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_SEND");
    if (denied) return denied;
    const { id } = await ctx.params;

    const hotel = await db.hotel.findUnique({ where: { id: auth.user.hotelId } });
    if (!hotel) return jsonError("Hotel not found.", 404, "NOT_FOUND");

    const result = await retryFailedMessages(id, {
      hotelId: auth.user.hotelId,
      hotelName: auth.user.hotelName,
      userId: auth.user.userId,
    });
    if (!result.ok) return jsonError(result.error, result.status, "RETRY_BLOCKED");

    return Response.json({ summary: result.summary });
  } catch (err) {
    return serverError(err, "The retry could not be run. Please try again.");
  }
}

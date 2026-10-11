import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { enrollJourneyCustomer } from "@/lib/scheduler";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/journeys/[id]/enroll — Phase 11 durable journey execution.
 *
 * Body: { customerIds?: string[], segmentId?: string }
 *
 * Enrolls customers into the journey (idempotent per customer — repeat calls
 * are no-ops). The worker's sweepJourneys() then delivers each step on its
 * scheduled day, exactly once per step/customer/occurrence, through the same
 * consent-gated campaign pipeline automations use.
 *
 * Segment-based enrollment fans out to the segment's current members
 * (snapshot at enrollment time — membership changes later do not retro-add).
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_SEND");
    if (denied) return denied;
    const hotelId = auth.user.hotelId;
    const { id } = await ctx.params;

    const journey = await db.journey.findFirst({
      where: { id, hotelId, enabled: true },
      select: { id: true, name: true },
    });
    if (!journey) return jsonError("Journey not found or disabled.", 404, "NOT_FOUND");

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    // Resolve the customer list (explicit ids and/or a segment's members).
    let customerIds: string[] = Array.isArray(body.customerIds)
      ? body.customerIds.filter((c: unknown): c is string => typeof c === "string")
      : [];

    if (typeof body.segmentId === "string") {
      const segment = await db.segment.findFirst({
        where: { id: body.segmentId, hotelId },
        select: { id: true },
      });
      if (!segment) return jsonError("Segment not found.", 404, "NOT_FOUND");
      const members = await db.segmentMember.findMany({
        where: { segmentId: segment.id },
        select: { customerId: true },
      });
      customerIds = [...new Set([...customerIds, ...members.map((m) => m.customerId)])];
    }

    if (customerIds.length === 0) {
      return jsonError("Select at least one customer or segment.");
    }
    if (customerIds.length > 500) {
      return jsonError("Enroll up to 500 customers at a time.");
    }

    let enrolled = 0;
    let already = 0;
    let rejected = 0;
    for (const customerId of customerIds) {
      const result = await enrollJourneyCustomer(id, customerId, hotelId);
      if (result.ok) {
        if (result.already) already += 1;
        else enrolled += 1;
      } else {
        rejected += 1;
      }
    }

    return Response.json({
      ok: true,
      enrolled,
      already,
      rejected,
      journey: journey.name,
    });
  } catch (err) {
    return serverError(err, "Enrollment could not be completed.");
  }
}

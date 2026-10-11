import { db } from "@/lib/db";
import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { recordLeadEvent } from "@/lib/lead-scoring";
import { parseWith, leadEventCreateSchema } from "@/lib/validation";

/** GET /api/lead-events?customerId=X — list lead events for a customer */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "LEAD_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const customerId = url.searchParams.get("customerId");
    if (!customerId) return jsonError("Customer ID is required.");

    const customer = await db.customer.findFirst({
      where: { id: customerId, hotelId: auth.user.hotelId },
    });
    if (!customer) return jsonError("Customer not found.", 404, "NOT_FOUND");

    const events = await db.leadEvent.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    // LeadEvent stores campaignId only (no direct relation) — resolve names
    // separately, tenant-scoped.
    const campaignIds = [
      ...new Set(events.map((e) => e.campaignId).filter((id): id is string => Boolean(id))),
    ];
    const campaigns = campaignIds.length
      ? await db.campaign.findMany({
          where: { id: { in: campaignIds }, hotelId: auth.user.hotelId },
          select: { id: true, name: true },
        })
      : [];
    const campaignNameById = new Map(campaigns.map((c) => [c.id, c.name]));

    return Response.json({
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        points: e.points,
        campaignName: e.campaignId ? (campaignNameById.get(e.campaignId) ?? null) : null,
        metadata: e.metadata,
        createdAt: e.createdAt.toISOString(),
      })),
      currentScore: customer.leadScore,
      currentTier: customer.leadTier ?? "COLD",
    });
  } catch (err) {
    return serverError(err, "Lead events could not be loaded.");
  }
}

/** POST /api/lead-events — manually record a lead event (e.g. booking page visit) */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "LEAD_CREATE");
    if (denied) return denied;

    const body = await req.json().catch(() => null);
    const parsed = parseWith(leadEventCreateSchema, body);
    if (!parsed.ok || !parsed.data) return jsonError(parsed.error ?? "Invalid request.");

    const customerId = parsed.data.customerId;
    const customer = await db.customer.findFirst({
      where: { id: customerId, hotelId: auth.user.hotelId },
    });
    if (!customer) return jsonError("Customer not found in your hotel.", 404, "NOT_FOUND");

    const result = await recordLeadEvent({
      hotelId: auth.user.hotelId,
      customerId,
      type: parsed.data.type,
      campaignId: parsed.data.campaignId,
      messageId: parsed.data.messageId,
      userId: auth.user.userId,
      metadata: parsed.data.metadata,
    });

    return Response.json(result, { status: 201 });
  } catch (err) {
    return serverError(err, "Lead event could not be recorded.");
  }
}

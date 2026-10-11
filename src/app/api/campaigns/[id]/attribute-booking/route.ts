import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/campaigns/[id]/attribute-booking
 * Record a booking that resulted from this campaign (revenue attribution).
 * Body: { customerId, amount, channel? }
 * Links the customer's most recent SENT message of the campaign (or given channel).
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_UPDATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const campaign = await db.campaign.findFirst({ where: { id, hotelId } });
    if (!campaign) return jsonError("Campaign not found in your hotel.", 404, "NOT_FOUND");

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const customerId = typeof body.customerId === "string" ? body.customerId : "";
    const amount = Number(body.amount);
    if (!customerId) return jsonError("Please choose the customer who booked.");
    if (!Number.isFinite(amount) || amount <= 0) {
      return jsonError("Please enter a valid booking amount.");
    }

    const customer = await db.customer.findFirst({ where: { id: customerId, hotelId } });
    if (!customer) return jsonError("Customer not found in your hotel.", 404, "NOT_FOUND");

    const channelFilter =
      typeof body.channel === "string" && ["WHATSAPP", "SMS", "EMAIL"].includes(body.channel)
        ? { channel: body.channel as "WHATSAPP" | "SMS" | "EMAIL" }
        : {};

    const message = await db.campaignMessage.findFirst({
      where: {
        campaignId: id,
        customerId,
        status: { in: ["SENT", "SIMULATED"] },
        ...channelFilter,
      },
      orderBy: { sentAt: "desc" },
    });
    if (!message) {
      return jsonError(
        "No sent message found for this customer in the campaign — attribution needs an actual send.",
        400,
        "NO_SENT_MESSAGE",
      );
    }

    await db.campaignMessage.update({
      where: { id: message.id },
      data: { bookingLinked: true, bookingAmount: amount, bookingAt: new Date() },
    });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.BOOKING_ATTRIBUTED,
      entityType: "campaign",
      entityId: id,
      metadata: { customerId, amount, channel: message.channel },
    });

    return Response.json(
      { ok: true, message: "Booking recorded against the campaign." },
      { status: 201 },
    );
  } catch (err) {
    return serverError(err, "Booking could not be recorded. Please try again.");
  }
}

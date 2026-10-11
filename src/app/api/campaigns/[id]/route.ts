import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { parseChannels } from "@/lib/campaigns";
import { funnelStats } from "@/lib/analytics";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/campaigns/[id] — detail + funnel stats + recent messages. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;
    const { id } = await ctx.params;

    const campaign = await db.campaign.findFirst({
      where: { id, hotelId },
      include: {
        segment: true,
        messageTemplateRef: {
          select: {
            id: true,
            name: true,
            approvalStatus: true,
            providerTemplateId: true,
            languageCode: true,
          },
        },
      },
    });
    if (!campaign) return jsonError("Campaign not found in your hotel.", 404, "NOT_FOUND");

    const stats = await funnelStats({ hotelId, campaignId: id });
    const messages = await db.campaignMessage.findMany({
      where: { campaignId: id, hotelId },
      include: { customer: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    return Response.json({
      campaign: {
        id: campaign.id,
        name: campaign.name,
        description: campaign.description,
        status: campaign.status,
        scheduleType: campaign.scheduleType,
        scheduledAt: campaign.scheduledAt,
        channels: parseChannels(campaign.channels),
        offer: campaign.offer,
        messageTemplate: campaign.messageTemplate,
        // RECHECK FIX (D): expose the template binding so the UI can show it.
        messageTemplateId: campaign.messageTemplateId,
        messageTemplateRef: campaign.messageTemplateRef
          ? {
              id: campaign.messageTemplateRef.id,
              name: campaign.messageTemplateRef.name,
              approvalStatus: campaign.messageTemplateRef.approvalStatus,
              providerTemplateId: campaign.messageTemplateRef.providerTemplateId,
              languageCode: campaign.messageTemplateRef.languageCode,
            }
          : null,
        audienceSegment: campaign.segment
          ? { id: campaign.segment.id, name: campaign.segment.name, type: campaign.segment.type }
          : null,
        automated: campaign.followUpStepId !== null,
        lastSentAt: campaign.lastSentAt,
        createdAt: campaign.createdAt,
      },
      stats,
      messages: messages.map((m) => ({
        id: m.id,
        customerId: m.customer.id,
        customerName: m.customer.name,
        customerPhone: m.customer.phone,
        channel: m.channel,
        recipient: m.recipient,
        status: m.status,
        skipReason: m.skipReason,
        provider: m.provider,
        providerMessageId: m.providerMessageId,
        failureReason: m.failureReason,
        personalizedMessage: m.personalizedMessage,
        sentAt: m.sentAt,
        deliveredAt: m.deliveredAt,
        openedAt: m.openedAt,
        clickedAt: m.clickedAt,
        bookingLinked: m.bookingLinked,
        bookingAmount: m.bookingAmount,
        createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    return serverError(err, "Campaign details could not be loaded. Please try again.");
  }
}

/** PATCH /api/campaigns/[id] — edit a DRAFT campaign. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_UPDATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const campaign = await db.campaign.findFirst({ where: { id, hotelId } });
    if (!campaign) return jsonError("Campaign not found in your hotel.", 404, "NOT_FOUND");
    if (campaign.followUpStepId) {
      return jsonError(
        "Automated campaigns are configured under Follow-up Engine settings.",
        400,
        "READ_ONLY",
      );
    }
    if (campaign.status === "COMPLETED" || campaign.status === "ARCHIVED") {
      return jsonError(
        "This campaign has already been sent and can no longer be edited.",
        400,
        "READ_ONLY",
      );
    }

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 3)
        return jsonError("Please enter a campaign name (at least 3 characters).");
      data.name = name;
    }
    if (body.messageTemplate !== undefined) {
      const template = typeof body.messageTemplate === "string" ? body.messageTemplate.trim() : "";
      if (template.length < 10)
        return jsonError("Please write a message (at least 10 characters).");
      data.messageTemplate = template;
    }
    // RECHECK FIX (D): bind / unbind an approved WhatsApp template.
    if (body.messageTemplateId !== undefined) {
      if (body.messageTemplateId === null) {
        data.messageTemplateId = null;
      } else if (typeof body.messageTemplateId === "string" && body.messageTemplateId.trim()) {
        const tpl = await db.messageTemplate.findFirst({
          where: { id: body.messageTemplateId.trim(), hotelId },
          select: { id: true },
        });
        if (!tpl)
          return jsonError(
            "Selected message template was not found in your hotel.",
            404,
            "NOT_FOUND",
          );
        data.messageTemplateId = tpl.id;
      }
    }
    if (body.offer !== undefined) {
      data.offer = typeof body.offer === "string" ? body.offer.trim().slice(0, 80) || null : null;
    }
    if (body.channels !== undefined) {
      const channels = Array.isArray(body.channels)
        ? body.channels.filter(
            (c: unknown): c is string =>
              typeof c === "string" && ["WHATSAPP", "SMS", "EMAIL"].includes(c),
          )
        : [];
      if (channels.length === 0) return jsonError("Please select at least one channel.");
      data.channels = JSON.stringify(channels);
    }
    if (body.segmentId !== undefined) {
      const segmentId = typeof body.segmentId === "string" ? body.segmentId : "";
      const segment = await db.segment.findFirst({ where: { id: segmentId, hotelId } });
      if (!segment) return jsonError("Selected audience segment was not found.", 404, "NOT_FOUND");
      data.segmentId = segmentId;
    }
    if (Object.keys(data).length === 0) return jsonError("Nothing to update.");

    const updated = await db.campaign.update({ where: { id }, data });
    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.CAMPAIGN_UPDATED,
      entityType: "campaign",
      entityId: id,
      metadata: { fields: Object.keys(data) },
    });
    return Response.json({ campaign: updated });
  } catch (err) {
    return serverError(err, "Campaign could not be updated. Please try again.");
  }
}

/** DELETE /api/campaigns/[id] — archive (soft delete; history preserved). */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_DELETE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const campaign = await db.campaign.findFirst({ where: { id, hotelId } });
    if (!campaign) return jsonError("Campaign not found in your hotel.", 404, "NOT_FOUND");
    if (campaign.followUpStepId) {
      return jsonError(
        "Automated campaigns are managed by the Follow-up Engine. Disable the step instead.",
        400,
        "PROTECTED",
      );
    }

    await db.campaign.update({ where: { id }, data: { status: "ARCHIVED" } });
    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.CAMPAIGN_ARCHIVED,
      entityType: "campaign",
      entityId: id,
      metadata: { name: campaign.name },
    });
    return Response.json({ ok: true, message: "Campaign archived." });
  } catch (err) {
    return serverError(err, "Campaign could not be archived. Please try again.");
  }
}

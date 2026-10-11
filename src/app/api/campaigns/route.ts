import { db } from "@/lib/db";
import { enforcePlanLimit, enforceFeature } from "@/lib/saas/guards";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { CHANNELS } from "@/lib/campaigns";
import { campaignList } from "@/lib/analytics";
import { TEMPLATE_VARIABLES } from "@/lib/personalize";
import { providerStatus } from "@/lib/providers";

/** GET /api/campaigns — list campaigns with quick stats + provider mode. */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_READ");
    if (denied) return denied;

    const [campaigns, followUpSteps] = await Promise.all([
      campaignList(auth.user.hotelId),
      db.followUpStep.findMany({
        where: { hotelId: auth.user.hotelId },
        orderBy: { offsetDays: "asc" },
      }),
    ]);

    return Response.json({
      campaigns,
      providerMode: providerStatus(),
      templateVariables: TEMPLATE_VARIABLES,
      followUpSteps: followUpSteps.map((s) => ({
        id: s.id,
        offsetDays: s.offsetDays,
        label: s.label,
        enabled: s.enabled,
        hasCampaign: true, // automated campaign is created lazily on engine run
      })),
    });
  } catch (err) {
    return serverError(err, "Campaigns could not be loaded. Please try again.");
  }
}

/** POST /api/campaigns — create a campaign. */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_CREATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;

    // Phase 10 §11/§12 — CAMPAIGNS entitlement + campaign limit (backend).
    const featureBlocked = await enforceFeature(hotelId, "CAMPAIGNS");
    if (featureBlocked) return featureBlocked;
    const limited = await enforcePlanLimit(hotelId, "campaigns");
    if (limited) return limited;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 3) return jsonError("Please enter a campaign name (at least 3 characters).");
    if (name.length > 80) return jsonError("Campaign name is too long (max 80 characters).");

    const segmentId = typeof body.segmentId === "string" ? body.segmentId : "";
    if (!segmentId) return jsonError("Please choose an audience segment.");
    const segment = await db.segment.findFirst({ where: { id: segmentId, hotelId } });
    if (!segment)
      return jsonError("Selected audience segment was not found in your hotel.", 404, "NOT_FOUND");

    const channels = Array.isArray(body.channels)
      ? body.channels.filter(
          (c: unknown): c is string => typeof c === "string" && CHANNELS.includes(c as never),
        )
      : [];
    if (channels.length === 0) {
      return jsonError("Please select at least one channel (WhatsApp, SMS or Email).");
    }

    const template = typeof body.messageTemplate === "string" ? body.messageTemplate.trim() : "";
    if (template.length < 10) {
      return jsonError("Please write a message (at least 10 characters).");
    }
    if (template.length > 1600) {
      return jsonError("Message is too long (max 1600 characters).");
    }
    if (
      /\{\{\s*\w+\s*\}\}/.test(
        template.replace(
          /\{\{(name|hotel_name|last_visit|booking_count|offer|booking_link)\}\}/g,
          "",
        ),
      )
    ) {
      return jsonError(
        "Message contains an unsupported {{variable}}. Allowed: name, hotel_name, last_visit, booking_count, offer, booking_link.",
      );
    }

    const offer = typeof body.offer === "string" ? body.offer.trim().slice(0, 80) || null : null;
    const description =
      typeof body.description === "string" ? body.description.trim().slice(0, 300) || null : null;

    // RECHECK FIX (D): optional WhatsApp template binding. The template must
    // belong to THIS hotel; approval/provider binding is validated at send
    // time (resolveWhatsAppTemplate) so a later approval change can never
    // send an unapproved template.
    let messageTemplateId: string | null = null;
    if (typeof body.messageTemplateId === "string" && body.messageTemplateId.trim()) {
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
      messageTemplateId = tpl.id;
    }

    const scheduleType = body.scheduleType === "SCHEDULED" ? "SCHEDULED" : "NOW";
    let scheduledAt: Date | null = null;
    if (scheduleType === "SCHEDULED") {
      if (typeof body.scheduledAt !== "string") {
        return jsonError("Please pick a date and time for the scheduled campaign.");
      }
      scheduledAt = new Date(body.scheduledAt);
      if (isNaN(scheduledAt.getTime())) return jsonError("The scheduled date is not valid.");
      if (scheduledAt.getTime() <= Date.now()) {
        return jsonError("The scheduled time must be in the future.");
      }
    }

    const campaign = await db.campaign.create({
      data: {
        hotelId,
        name,
        description,
        status: scheduleType === "SCHEDULED" ? "SCHEDULED" : "DRAFT",
        scheduleType,
        scheduledAt,
        segmentId,
        channels: JSON.stringify(channels),
        offer,
        messageTemplate: template,
        messageTemplateId,
        createdById: userId,
      },
    });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.CAMPAIGN_CREATED,
      entityType: "campaign",
      entityId: campaign.id,
      metadata: { name, audience: segment.name, channels },
    });

    return Response.json({ campaign }, { status: 201 });
  } catch (err) {
    return serverError(err, "Campaign could not be created. Please try again.");
  }
}

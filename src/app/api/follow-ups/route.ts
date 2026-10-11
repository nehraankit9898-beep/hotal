import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { ensureFollowUpSteps } from "@/lib/campaigns";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

/** GET /api/follow-ups — steps for this hotel (defaults ensured). */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_READ");
    if (denied) return denied;
    const steps = await ensureFollowUpSteps(auth.user.hotelId);
    return Response.json({
      steps: steps.map((s) => ({
        id: s.id,
        offsetDays: s.offsetDays,
        label: s.label,
        messageTemplate: s.messageTemplate,
        channels: JSON.parse(s.channels) as string[],
        enabled: s.enabled,
      })),
    });
  } catch (err) {
    return serverError(err, "Follow-up settings could not be loaded. Please try again.");
  }
}

/**
 * PUT /api/follow-ups — update one step (timing, template, channels, enabled).
 * Body: { id, offsetDays?, label?, messageTemplate?, channels?, enabled? }
 */
export async function PUT(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_UPDATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;

    const body = await readJson(req);
    if (!body || typeof body.id !== "string")
      return jsonError("Invalid request. Please try again.");

    const step = await db.followUpStep.findFirst({ where: { id: body.id, hotelId } });
    if (!step) return jsonError("Follow-up step not found in your hotel.", 404, "NOT_FOUND");

    const data: Record<string, unknown> = {};

    if (body.offsetDays !== undefined) {
      const offsetDays = Number(body.offsetDays);
      if (!Number.isInteger(offsetDays) || offsetDays < 1 || offsetDays > 365) {
        return jsonError("Timing must be between 1 and 365 days after checkout.");
      }
      if (offsetDays !== step.offsetDays) {
        const clash = await db.followUpStep.findFirst({
          where: { hotelId, offsetDays, NOT: { id: step.id } },
        });
        if (clash)
          return jsonError(
            "Another follow-up step already uses this timing.",
            409,
            "DUPLICATE_OFFSET",
          );
        data.offsetDays = offsetDays;
      }
    }

    if (body.label !== undefined) {
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (label.length < 2) return jsonError("Please enter a step name.");
      data.label = label.slice(0, 60);
    }

    if (body.messageTemplate !== undefined) {
      const template = typeof body.messageTemplate === "string" ? body.messageTemplate.trim() : "";
      if (template.length < 10)
        return jsonError("Please write the message (at least 10 characters).");
      data.messageTemplate = template.slice(0, 1600);
    }

    if (body.channels !== undefined) {
      const channels = Array.isArray(body.channels)
        ? body.channels.filter(
            (c: unknown): c is "WHATSAPP" | "SMS" | "EMAIL" =>
              typeof c === "string" && ["WHATSAPP", "SMS", "EMAIL"].includes(c),
          )
        : [];
      if (channels.length === 0) return jsonError("Please select at least one channel.");
      data.channels = JSON.stringify(channels);
    }

    if (body.enabled !== undefined) {
      data.enabled = Boolean(body.enabled);
    }

    if (Object.keys(data).length === 0) return jsonError("Nothing to update.");

    await db.followUpStep.update({ where: { id: step.id }, data });

    // Keep the automated campaign's template/channels in sync
    const autoCampaign = await db.campaign.findUnique({ where: { followUpStepId: step.id } });
    if (autoCampaign) {
      await db.campaign.update({
        where: { id: autoCampaign.id },
        data: {
          ...(data.messageTemplate !== undefined
            ? { messageTemplate: data.messageTemplate as string }
            : {}),
          ...(data.channels !== undefined ? { channels: data.channels as string } : {}),
          ...(data.offsetDays !== undefined
            ? { name: `Auto: ${String(data.label ?? step.label)} (+${data.offsetDays}d)` }
            : {}),
        },
      });
    }

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.FOLLOWUP_SETTINGS_UPDATED,
      entityType: "follow_up_step",
      entityId: step.id,
      metadata: { fields: Object.keys(data) },
    });

    return Response.json({ ok: true });
  } catch (err) {
    return serverError(err, "Follow-up settings could not be saved. Please try again.");
  }
}

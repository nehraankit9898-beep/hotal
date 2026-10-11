import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { executeCampaignSend } from "@/lib/campaigns";
import { db } from "@/lib/db";
import { enqueueJob } from "@/lib/queue";
import { inlineSendThreshold } from "@/lib/env";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { enforcePlanLimit, enforceFeature } from "@/lib/saas/guards";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/campaigns/[id]/send — execute the send pipeline (consent-gated).
 *
 * Phase 7 (spec §15): audiences larger than INLINE_SEND_THRESHOLD are handed
 * to the persistent background queue (HTTP 202 + jobId) instead of running
 * hundreds of provider calls inside one HTTP request. Small audiences still
 * send inline (fast, test-friendly). Both paths share the same reserve-then-
 * send pipeline, so duplicates are impossible across retries or path switches.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_SEND");
    if (denied) return denied;
    const { id } = await ctx.params;

    // Optional overrides: {"force": true} sends now; {"inline": true} always
    // executes synchronously (used by tests and small audiences).
    let force = false;
    let inline = false;
    try {
      const body = (await req.json()) as { force?: boolean; inline?: boolean } | null;
      force = Boolean(body?.force);
      inline = Boolean(body?.inline);
    } catch {
      // no body — fine
    }

    const hotel = await db.hotel.findUnique({ where: { id: auth.user.hotelId } });
    if (!hotel) return jsonError("Hotel not found.", 404, "NOT_FOUND");

    // Phase 10 §11/§12 — CAMPAIGNS entitlement + monthly message limit.
    const featureBlocked = await enforceFeature(auth.user.hotelId, "CAMPAIGNS");
    if (featureBlocked) return featureBlocked;
    const limited = await enforcePlanLimit(auth.user.hotelId, "messages");
    if (limited) return limited;

    if (force) {
      const campaign = await db.campaign.findFirst({ where: { id, hotelId: auth.user.hotelId } });
      if (campaign?.scheduleType === "SCHEDULED") {
        // Send-now override: temporarily treat as NOW
        await db.campaign.update({
          where: { id },
          data: { scheduleType: "NOW", scheduledAt: null },
        });
      }
    }

    // Tenant check first (404 for foreign campaigns — indistinguishable).
    const campaign = await db.campaign.findFirst({ where: { id, hotelId: auth.user.hotelId } });
    if (!campaign) return jsonError("Campaign not found.", 404, "NOT_FOUND");

    // Queue decision: estimate the audience (active customers opted in for the
    // campaign's channel — a cheap upper bound of the pipeline's eligibility).
    if (!inline) {
      const threshold = inlineSendThreshold();
      const audience = await db.customer.count({
        where: {
          hotelId: auth.user.hotelId,
          status: "ACTIVE",
          optOut: false,
        },
      });
      if (audience > threshold) {
        const jobId = await enqueueJob(
          "CAMPAIGN_SEND",
          {
            campaignId: id,
            hotelId: auth.user.hotelId,
            hotelName: auth.user.hotelName,
            userId: auth.user.userId,
          },
          { hotelId: auth.user.hotelId, createdBy: auth.user.userId },
        );
        await logAudit({
          req,
          hotelId: auth.user.hotelId,
          userId: auth.user.userId,
          action: AUDIT_ACTIONS.CAMPAIGN_QUEUED,
          entityType: "campaign",
          entityId: id,
          metadata: { jobId, audienceEstimate: audience },
        });
        logger.info("campaign.queued", { campaignId: id, jobId, audience });
        return Response.json(
          {
            queued: true,
            jobId,
            message: "Campaign queued for delivery. Track progress from the jobs endpoint.",
          },
          { status: 202 },
        );
      }
    }

    const result = await executeCampaignSend(id, {
      hotelId: auth.user.hotelId,
      hotelName: auth.user.hotelName,
      userId: auth.user.userId,
    });
    if (!result.ok) return jsonError(result.error, result.status, "SEND_BLOCKED");

    // Phase 10 §12 — metering happens INSIDE executeCampaignSend (BUG-6):
    // real + simulated accepted deliveries count against the plan for EVERY
    // send path (HTTP, scheduled worker, automations, journeys). This route
    // deliberately does NOT meter again — it would double-charge the tenant.

    return Response.json({ summary: result.summary });
  } catch (err) {
    return serverError(err, "The campaign could not be sent. Please try again.");
  }
}

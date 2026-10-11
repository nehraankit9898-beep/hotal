import { db } from "@/lib/db";
import { jsonError, serverError } from "@/lib/api-helpers";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { verifyWebhookSignature } from "@/lib/webhook-verify";
import { getTrackingWebhookSecret } from "@/lib/config";
import { parseWith, providerWebhookEventSchema } from "@/lib/validation";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

/**
 * POST /api/tracking/webhook — provider engagement tracking endpoint (Phase 7 hardened).
 *
 * SECURITY:
 *  - HMAC-SHA256 over the raw body via X-Webhook-Signature / X-Webhook-Timestamp
 *    (replaces the static x-webhook-secret header; constant-time compare).
 *  - Replay window ±5 min; duplicate deliveries are idempotent ("first write
 *    wins" timestamps; status transitions only move forward).
 *  - hotelId is derived from the stored message via providerMessageId — never
 *    from the payload.
 *
 * Body: { providerMessageId, event: "delivered"|"opened"|"clicked"|"failed", failureReason?, eventId? }
 */
export async function POST(req: Request) {
  try {
    const damping = await checkRateLimit(`wh-provider:${clientIp(req)}`, 300, 60 * 1000);
    if (!damping.allowed) {
      return jsonError("Too many requests", 429, "RATE_LIMITED");
    }

    const secret = getTrackingWebhookSecret();
    const rawBody = await req.text();
    const verified = verifyWebhookSignature(rawBody, req.headers, secret);
    if (!verified.ok) {
      await logAudit({
        req,
        action: AUDIT_ACTIONS.WEBHOOK_REJECTED,
        entityType: "webhook",
        entityId: "provider-tracking",
        metadata: { reason: verified.code },
      });
      return jsonError(verified.message, verified.status, verified.code);
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return jsonError("Invalid request body.");
    }
    const parsed = parseWith(providerWebhookEventSchema, json);
    if (!parsed.ok || !parsed.data) {
      return jsonError(parsed.error ?? "Invalid payload.");
    }
    const { providerMessageId, event, failureReason } = parsed.data;

    const message = await db.campaignMessage.findFirst({
      where: { providerMessageId },
      orderBy: { createdAt: "desc" },
    });
    if (!message) {
      // Not ours / unknown id — respond OK so providers don't retry forever,
      // but log for diagnosis.
      return Response.json({ ok: true, matched: false });
    }

    const now = new Date();
    const data: Record<string, unknown> = {};
    if (event === "delivered") data.deliveredAt = message.deliveredAt ?? now;
    if (event === "opened") {
      data.openedAt = message.openedAt ?? now;
      if (!message.deliveredAt) data.deliveredAt = now; // read implies delivered
    }
    if (event === "clicked") {
      data.clickedAt = message.clickedAt ?? now;
      data.openedAt = message.openedAt ?? now; // click implies open
      data.deliveredAt = message.deliveredAt ?? now; // click implies delivered
    }
    if (event === "failed") {
      // Only move a not-yet-delivered message to FAILED (idempotent, monotonic).
      if (message.deliveredAt || message.openedAt || message.clickedAt) {
        data.failureReason = failureReason ?? "Provider reported failure (after delivery)";
      } else {
        data.status = "FAILED";
        data.failureReason = failureReason ?? "Provider reported failure";
      }
    }

    await db.campaignMessage.update({ where: { id: message.id }, data });

    await logAudit({
      req,
      hotelId: message.hotelId,
      action: AUDIT_ACTIONS.TRACKING_EVENT,
      entityType: "campaign_message",
      entityId: message.id,
      metadata: { event, provider: message.provider },
    });

    return Response.json({ ok: true, matched: true, event });
  } catch (err) {
    return serverError(err, "Webhook could not be processed.");
  }
}

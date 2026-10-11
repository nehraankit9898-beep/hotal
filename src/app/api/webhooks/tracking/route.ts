import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import {
  onCampaignMessageOpened,
  onCampaignMessageClicked,
  onCampaignMessageReplied,
} from "@/lib/lead-scoring";
import { verifyWebhookSignature } from "@/lib/webhook-verify";
import { getTrackingWebhookSecret } from "@/lib/config";
import { parseWith, trackingWebhookEventSchema } from "@/lib/validation";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

/**
 * POST /api/webhooks/tracking — engagement tracking webhook (Phase 7 hardened).
 *
 * SECURITY:
 *  - HMAC-SHA256 signature over the RAW body via X-Webhook-Signature +
 *    X-Webhook-Timestamp (±5 min replay window). Query-string secrets were
 *    REMOVED (?secret= is no longer accepted).
 *  - Constant-time comparison; replay of the same signed payload within the
 *    window is harmless because downstream effects are idempotent
 *    (LeadEvent unique constraint + "first write wins" timestamps).
 *  - The hotelId is NEVER accepted from the payload — it is always derived
 *    from the stored campaign message record (tenant ownership by lookup).
 *  - Per-IP damping (best-effort) + fail-closed when the secret is unset.
 *
 * Body: { messageId, event: "OPENED" | "CLICKED" | "REPLIED", reply? }
 */
export async function POST(req: Request) {
  try {
    const damping = await checkRateLimit(`wh-tracking:${clientIp(req)}`, 300, 60 * 1000);
    if (!damping.allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const secret = getTrackingWebhookSecret();
    const rawBody = await req.text();
    const verified = verifyWebhookSignature(rawBody, req.headers, secret);
    if (!verified.ok) {
      await logAudit({
        req,
        action: AUDIT_ACTIONS.WEBHOOK_REJECTED,
        entityType: "webhook",
        entityId: "tracking",
        metadata: { reason: verified.code },
      });
      return NextResponse.json({ error: verified.message }, { status: verified.status });
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = parseWith(trackingWebhookEventSchema, json);
    if (!parsed.ok || !parsed.data) {
      return NextResponse.json({ error: parsed.error ?? "Invalid payload" }, { status: 400 });
    }
    const { messageId, event, reply } = parsed.data;

    const msg = await db.campaignMessage.findUnique({ where: { id: messageId } });
    // Tenant ownership is derived from the stored record — the payload does
    // not carry (and cannot override) a hotelId.
    if (!msg) return NextResponse.json({ error: "Message not found" }, { status: 404 });

    switch (event) {
      case "OPENED":
        await onCampaignMessageOpened(messageId);
        break;
      case "CLICKED":
        await onCampaignMessageClicked(messageId);
        break;
      case "REPLIED":
        await onCampaignMessageReplied(messageId, String(reply ?? ""));
        await applyInboundOptOut(msg, messageId, String(reply ?? ""));
        break;
    }

    return Response.json({ ok: true });
  } catch (err) {
    console.error("[webhooks/tracking] error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Webhook failed" }, { status: 500 });
  }
}

/**
 * AUDIT FIX (P11-STOP-1): outbound messages promise "Reply STOP to opt out",
 * but nothing ingested inbound STOP replies — the advertised unsubscribe
 * channel was a dead end and opted-out-by-SMS customers kept receiving
 * messages. A REPLIED event whose text matches an opt-out keyword now flips
 * the customer's optOut immediately (the send pipeline's consent gates read
 * it on every send), and the action is audited.
 */
const INBOUND_OPT_OUT_RE = /^\s*(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|OPTOUT|OPT\s?OUT)\b/i;

async function applyInboundOptOut(
  msg: { customerId: string | null; hotelId: string | null; channel: string },
  messageId: string,
  replyText: string,
): Promise<void> {
  if (!msg.customerId || !INBOUND_OPT_OUT_RE.test(replyText)) return;
  try {
    await db.customer.update({
      where: { id: msg.customerId },
      data: { optOut: true },
    });
    await logAudit({
      hotelId: msg.hotelId ?? undefined,
      action: "CUSTOMER_OPTED_OUT_INBOUND",
      entityType: "Customer",
      entityId: msg.customerId,
      metadata: { messageId, channel: msg.channel, source: "inbound_reply" },
    });
  } catch (err) {
    // Never fail the webhook on the opt-out side effect — the reply event
    // itself was already recorded.
    console.error("[webhooks/tracking] opt-out handling failed:", err instanceof Error ? err.message : err);
  }
}

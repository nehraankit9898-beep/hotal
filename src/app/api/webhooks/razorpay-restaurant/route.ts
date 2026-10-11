import { createHmac, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { jsonError } from "@/lib/api-helpers";
import { restaurantGatewayCredentials, recordGatewayCapture } from "@/lib/billing";
import { logAudit } from "@/lib/audit";

/**
 * Phase 14 — Razorpay webhook for RESTAURANT bill payments (provider-native).
 * SEPARATE from the SaaS subscription webhook (/api/webhooks/billing).
 *
 * Security model (documented, provider-accurate):
 *  - `x-razorpay-signature` = HMAC-SHA256(rawBody, webhookSecret) where the
 *    secret is RAZORPAY_RESTAURANT_WEBHOOK_SECRET (platform env) or the
 *    tenant's stored webhook_secret integration credential.
 *  - Duplicate event ids are recorded and answered 200 without re-allocating
 *    (RestaurantWebhookEvent unique fence) — replay protection.
 *  - Amount/currency binding: only `payment.captured` events for our own
 *    order ids allocate money, and only after the amount matches the intent.
 */

export async function POST(req: Request) {
  const raw = await req.text();
  const signature = req.headers.get("x-razorpay-signature") ?? "";

  // Resolve the verifying secret: platform env first, then tenant integration.
  const secretCandidates: string[] = [];
  if (process.env.RAZORPAY_RESTAURANT_WEBHOOK_SECRET) {
    secretCandidates.push(process.env.RAZORPAY_RESTAURANT_WEBHOOK_SECRET);
  }
  // Parse the payload (no trust — signature is verified before allocation).
  let payload: {
    event?: string;
    payload?: { payment?: { entity?: { id?: string; order_id?: string; amount?: number; notes?: { hotelId?: string; billId?: string } } } };
  } = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    return jsonError("Invalid JSON payload.", 400, "BAD_REQUEST");
  }

  const hotelIdFromNotes = payload.payload?.payment?.entity?.notes?.hotelId;
  if (hotelIdFromNotes) {
    const creds = await restaurantGatewayCredentials(hotelIdFromNotes);
    // Tenant webhook secrets live on the integration row.
    const integration = await db.integration.findFirst({
      where: { hotelId: hotelIdFromNotes, type: "RAZORPAY", enabled: true },
      select: { credentials: true },
    });
    if (integration?.credentials) {
      try {
        const { decryptCredentials } = await import("@/lib/crypto");
        const decrypted = decryptCredentials({ hotelId: hotelIdFromNotes, integrationType: "RAZORPAY" }, integration.credentials) as Record<string, unknown>;
        const ws = decrypted.webhook_secret ?? decrypted.webhookSecret;
        if (typeof ws === "string" && ws) secretCandidates.push(ws);
      } catch {
        /* decrypt failure falls through to env candidates */
      }
      void creds;
    }
  }

  if (secretCandidates.length === 0) {
    return jsonError("Webhook secret not configured; cannot verify.", 503, "WEBHOOK_NOT_CONFIGURED");
  }

  const valid = secretCandidates.some((secret) => {
    const expected = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"));
    const provided = Buffer.from(signature);
    if (expected.length !== provided.length || provided.length === 0) return false;
    return timingSafeEqual(expected, provided);
  });
  if (!valid) {
    return jsonError("Signature verification failed.", 401, "SIGNATURE_INVALID");
  }

  // Verified — record the event for dedupe.
  const eventId =
    (payload.payload?.payment?.entity?.id ?? "") + ":" + (payload.event ?? "") + ":" + (payload.payload?.payment?.entity?.order_id ?? "");
  if (!eventId || eventId === "::") {
    return jsonError("Unrecognized webhook payload.", 400, "BAD_REQUEST");
  }
  try {
    await db.restaurantWebhookEvent.create({
      data: {
        hotelId: hotelIdFromNotes ?? null,
        provider: "RAZORPAY",
        eventId,
        type: payload.event ?? null,
        payload: raw.slice(0, 8000),
        status: "PROCESSED",
      },
    });
  } catch {
    // Unique violation = replay. Answer 200; never re-allocate.
    return Response.json({ ok: true, duplicate: true });
  }

  if (payload.event !== "payment.captured") {
    return Response.json({ ok: true, ignored: payload.event });
  }

  const entity = payload.payload?.payment?.entity;
  const gatewayOrderId = entity?.order_id ?? "";
  const gatewayPaymentId = entity?.id ?? "";
  const amount = entity?.amount ?? -1;
  const billId = entity?.notes?.billId;
  if (!gatewayOrderId || !gatewayPaymentId || !billId) {
    return Response.json({ ok: true, ignored: "missing binding fields" });
  }

  const intent = await db.billPayment.findFirst({
    where: { gatewayOrderId, gateway: "RAZORPAY", billId },
  });
  if (!intent) {
    return Response.json({ ok: true, ignored: "unknown order intent" });
  }
  if (intent.amountMinor !== amount) {
    // Amount mismatch → never allocate; surface for reconciliation.
    await db.restaurantWebhookEvent.updateMany({
      where: { provider: "RAZORPAY", eventId },
      data: { status: "FAILED" },
    });
    return jsonError("Webhook amount does not match the intent.", 422, "AMOUNT_MISMATCH");
  }

  const result = await recordGatewayCapture({
    hotelId: intent.hotelId,
    intentPaymentId: intent.id,
    gatewayOrderId,
    gatewayPaymentId,
    expectedAmountMinor: intent.amountMinor,
  });
  if (!result.ok) {
    // AUDIT FIX (P14-WBH-1): the dedupe row was committed BEFORE allocation,
    // so a transient failure here answered every provider retry with
    // "duplicate" forever — captured money was never allocated. The event row
    // is REMOVED so Razorpay's retry can reprocess; the gatewayPaymentId
    // unique fence inside recordGatewayCapture keeps a successful allocation
    // exactly-once (at-least-once delivery + idempotent allocation). The
    // failed attempt stays visible in the audit log.
    await db.restaurantWebhookEvent.deleteMany({ where: { provider: "RAZORPAY", eventId } });
    await logAudit({
      hotelId: intent.hotelId,
      action: "RESTAURANT_WEBHOOK_ALLOCATION_FAILED",
      entityType: "BillPayment",
      entityId: intent.id,
      metadata: { eventId, reason: result.reason ?? "Capture rejected.", gatewayOrderId, gatewayPaymentId },
    });
    return jsonError(result.reason ?? "Capture rejected.", 422, "CAPTURE_REJECTED");
  }
  return Response.json({ ok: true });
}

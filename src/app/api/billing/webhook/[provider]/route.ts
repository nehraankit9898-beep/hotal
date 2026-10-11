import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { requestIp } from "@/lib/login-security";
import {
  getProviderSettings,
  verifyRazorpaySignature,
  verifyStripeSignature,
  decryptPlatformSecret,
  markPaymentPaid,
  markPaymentFailed,
  reconcileProviderPayment,
} from "@/lib/saas/billing";
import { logSecurityEvent } from "@/lib/saas/security";

/**
 * POST /api/billing/webhook/[provider] — payment provider webhooks (Phase 10 §6).
 *
 * PUBLIC endpoint (providers cannot authenticate) — security comes from:
 *   1. provider-native SIGNATURE verification (HMAC), fail-closed
 *   2. REPLAY protection (Stripe timestamp tolerance)
 *   3. IDEMPOTENCY (payment status transitions are guarded updates; repeated
 *      events are acknowledged without double-processing)
 *   4. AUDIT FIX (F06) — EVENT BINDING: a valid signature proves the SENDER,
 *      not that the event belongs to THIS invoice. Every capture is reconciled
 *      against the persisted Payment (provider order id, expected amount in
 *      minor units, currency, provider/mode) BEFORE any subscription
 *      activation. Mismatching — even correctly signed — events are
 *      QUARANTINED (security event + audit log) and never honoured.
 *   5. AUDIT FIX (F17) — FAILED → PAID recovery: a provider-authentic capture
 *      for the correct order recovers an earlier FAILED attempt, so a customer
 *      whose payment eventually succeeded is never left unfulfilled.
 *   6. rate limiting + security-event logging
 *
 * Supported: razorpay (payment.captured / payment.failed), stripe
 * (payment_intent.succeeded / payment_intent.payment_failed).
 * Unconfigured providers return 503 (fail-closed) BEFORE reading the body.
 */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  try {
    const ip = requestIp(req);
    const burst = await checkRateLimit(`billing-webhook:${provider}:${ip}`, 120, 60 * 1000);
    if (!burst.allowed) {
      // AUDIT FIX (webhook-ack): the old response was 200 {received:true} —
      // an ACK for an event that was NOT processed. Payment providers treat
      // 2xx as "delivered" and never retry, so a burst of legitimate webhook
      // events could be silently DROPPED. 429 tells the provider to retry
      // later (Razorpay/Stripe both re-deliver on non-2xx), which is the
      // honest answer — the event is safe to re-deliver because
      // markPaymentPaid is idempotent.
      return NextResponse.json(
        { error: { code: "RATE_LIMITED", message: "Too many webhook events — retry later." } },
        { status: 429, headers: { "Retry-After": String(burst.retryAfterSeconds) } },
      );
    }

    const providers = await getProviderSettings();
    const rawBody = await req.text();

    if (provider === "razorpay") {
      const config = providers.razorpay;
      if (!config.enabled || !config.webhookSecretEnc) {
        return NextResponse.json(
          { error: { code: "NOT_CONFIGURED", message: "Webhook not configured." } },
          { status: 503 },
        );
      }
      const signature = req.headers.get("x-razorpay-signature") ?? "";
      const secret = decryptPlatformSecret(config.webhookSecretEnc, "razorpay-webhook");
      if (!verifyRazorpaySignature(rawBody, signature, secret)) {
        await logSecurityEvent({
          type: "WEBHOOK_REJECTED",
          severity: "CRITICAL",
          ipAddress: ip,
          details: { provider, reason: "invalid-signature" },
        });
        await logAudit({
          action: AUDIT_ACTIONS.WEBHOOK_REJECTED,
          entityType: "billing_webhook",
          metadata: { provider },
          ipAddress: ip,
        });
        return NextResponse.json(
          { error: { code: "INVALID_SIGNATURE", message: "Signature verification failed." } },
          { status: 400 },
        );
      }
      const event = JSON.parse(rawBody) as {
        event?: string;
        payload?: {
          payment?: {
            entity?: {
              id?: string;
              order_id?: string;
              amount?: number;
              currency?: string;
              notes?: Record<string, string>;
            };
          };
        };
      };
      const entity = event.payload?.payment?.entity;
      // RECHECK FIX (B): the internal payment id in order notes is only a
      // HINT — checkout creates the Razorpay order BEFORE the local Payment
      // row exists, so notes cannot carry it (and must not be required).
      // The persisted providerOrderId ↔ Payment mapping is authoritative:
      // resolve by hint first, then by order_id lookup. Events that resolve
      // to NO local payment are foreign (another product on the same
      // Razorpay account) and are acked + ignored, as before.
      const hintedPaymentId = entity?.notes?.paymentId ?? null;
      let paymentId = hintedPaymentId;
      if (!paymentId && entity?.order_id) {
        const bound = await db.payment.findFirst({
          where: { providerOrderId: entity.order_id, provider: "razorpay" },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        paymentId = bound?.id ?? null;
      }
      if (!paymentId) {
        // Not a StayLoop checkout event (e.g. another product) — ack + ignore.
        return NextResponse.json({ received: true });
      }

      if (event.event === "payment.captured") {
        // F06: bind the (already signature-verified) event to the expected
        // invoice before honouring it.
        const verdict = await reconcileProviderPayment({
          provider: "razorpay",
          providerOrderId: entity?.order_id ?? null,
          hintedPaymentId,
          amountMinor: entity?.amount ?? null,
          currency: entity?.currency ?? null,
          providerPaymentId: entity?.id ?? null,
        });
        if (!verdict.ok) {
          if (verdict.quarantine) {
            await logSecurityEvent({
              type: "WEBHOOK_ANOMALY",
              severity: "CRITICAL",
              ipAddress: ip,
              details: { provider, reason: verdict.reason, ...verdict.details },
            });
            await logAudit({
              action: AUDIT_ACTIONS.WEBHOOK_REJECTED,
              entityType: "billing_webhook",
              metadata: { provider, reason: verdict.reason, quarantined: true, ...verdict.details },
              ipAddress: ip,
            });
          }
          // Acknowledge with the honest result — the provider does not need to
          // redeliver (a retry would fail the same binding check), but nothing
          // was activated. 200 keeps the webhook from being disabled.
          return NextResponse.json({ received: true, ok: false, reason: verdict.reason });
        }
        const result = await markPaymentPaid({
          paymentId,
          providerPaymentId: entity?.id,
          provider: "razorpay",
          reason: "razorpay:payment.captured",
        });
        return NextResponse.json({
          received: true,
          ok: result.ok,
          alreadyPaid: result.alreadyPaid ?? false,
        });
      }
      if (event.event === "payment.failed") {
        // F06 (failed side): only mark OUR payment failed when the event still
        // belongs to it (order binding), otherwise ignore quietly.
        const verdict = await reconcileProviderPayment({
          provider: "razorpay",
          providerOrderId: entity?.order_id ?? null,
          hintedPaymentId,
          amountMinor: entity?.amount ?? null,
          currency: entity?.currency ?? null,
          providerPaymentId: entity?.id ?? null,
        });
        if (verdict.ok) {
          await markPaymentFailed(paymentId, "Razorpay reported payment failed");
        } else if (verdict.quarantine) {
          await logSecurityEvent({
            type: "WEBHOOK_ANOMALY",
            severity: "WARNING",
            ipAddress: ip,
            details: {
              provider,
              reason: verdict.reason,
              kind: "payment.failed",
              ...verdict.details,
            },
          });
        }
        return NextResponse.json({ received: true, ok: true });
      }
      return NextResponse.json({ received: true });
    }

    if (provider === "stripe") {
      const config = providers.stripe;
      if (!config.enabled || !config.webhookSecretEnc) {
        return NextResponse.json(
          { error: { code: "NOT_CONFIGURED", message: "Webhook not configured." } },
          { status: 503 },
        );
      }
      const signature = req.headers.get("stripe-signature") ?? "";
      const secret = decryptPlatformSecret(config.webhookSecretEnc, "stripe-webhook");
      if (!verifyStripeSignature(rawBody, signature, secret)) {
        await logSecurityEvent({
          type: "WEBHOOK_REJECTED",
          severity: "CRITICAL",
          ipAddress: ip,
          details: { provider, reason: "invalid-signature" },
        });
        await logAudit({
          action: AUDIT_ACTIONS.WEBHOOK_REJECTED,
          entityType: "billing_webhook",
          metadata: { provider },
          ipAddress: ip,
        });
        return NextResponse.json(
          { error: { code: "INVALID_SIGNATURE", message: "Signature verification failed." } },
          { status: 400 },
        );
      }
      const event = JSON.parse(rawBody) as {
        type?: string;
        data?: {
          object?: {
            id?: string;
            amount?: number;
            currency?: string;
            metadata?: Record<string, string>;
          };
        };
      };
      const paymentId = event.data?.object?.metadata?.paymentId;
      if (!paymentId) return NextResponse.json({ received: true }); // foreign event (no Stripe order mapping exists — checkout creates none)
      const obj = event.data?.object;

      if (event.type === "payment_intent.succeeded") {
        const verdict = await reconcileProviderPayment({
          provider: "stripe",
          providerOrderId: obj?.id ?? null,
          hintedPaymentId: paymentId,
          amountMinor: obj?.amount ?? null,
          currency: obj?.currency ?? null,
          providerPaymentId: obj?.id ?? null,
        });
        if (!verdict.ok) {
          if (verdict.quarantine) {
            await logSecurityEvent({
              type: "WEBHOOK_ANOMALY",
              severity: "CRITICAL",
              ipAddress: ip,
              details: { provider, reason: verdict.reason, ...verdict.details },
            });
            await logAudit({
              action: AUDIT_ACTIONS.WEBHOOK_REJECTED,
              entityType: "billing_webhook",
              metadata: { provider, reason: verdict.reason, quarantined: true, ...verdict.details },
              ipAddress: ip,
            });
          }
          return NextResponse.json({ received: true, ok: false, reason: verdict.reason });
        }
        const result = await markPaymentPaid({
          paymentId,
          providerPaymentId: obj?.id,
          provider: "stripe",
          reason: "stripe:payment_intent.succeeded",
        });
        return NextResponse.json({
          received: true,
          ok: result.ok,
          alreadyPaid: result.alreadyPaid ?? false,
        });
      }
      if (event.type === "payment_intent.payment_failed") {
        const verdict = await reconcileProviderPayment({
          provider: "stripe",
          providerOrderId: obj?.id ?? null,
          hintedPaymentId: paymentId,
          amountMinor: obj?.amount ?? null,
          currency: obj?.currency ?? null,
          providerPaymentId: obj?.id ?? null,
        });
        if (verdict.ok) {
          await markPaymentFailed(paymentId, "Stripe reported payment failed");
        } else if (verdict.quarantine) {
          await logSecurityEvent({
            type: "WEBHOOK_ANOMALY",
            severity: "WARNING",
            ipAddress: ip,
            details: {
              provider,
              reason: verdict.reason,
              kind: "payment_intent.payment_failed",
              ...verdict.details,
            },
          });
        }
        return NextResponse.json({ received: true, ok: true });
      }
      return NextResponse.json({ received: true });
    }

    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Unknown webhook provider." } },
      { status: 404 },
    );
  } catch (err) {
    // Webhooks must never leak internals; log server-side only.
    console.error("[billing-webhook] error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Webhook processing failed." } },
      { status: 500 },
    );
  }
}

import { createHmac, timingSafeEqual } from "crypto";

/**
 * Webhook signature verification — Phase 7.
 *
 * Protocol (Stripe/GitHub style):
 *   X-Webhook-Signature  = base64url(HMAC-SHA256(secret, "<timestamp>.<rawBody>"))
 *   X-Webhook-Timestamp  = unix seconds of signing time
 *
 * - The secret is NEVER accepted via query string (removed pattern: ?secret=).
 * - Signature is computed over the RAW request body (not re-serialized JSON).
 * - Constant-time comparison.
 * - Replay window: timestamp must be within ±tolerance of now.
 * - Idempotency/replay of identical deliveries is handled by callers via
 *   event-id dedup + database unique constraints.
 */

export const SIGNATURE_HEADER = "x-webhook-signature";
export const TIMESTAMP_HEADER = "x-webhook-timestamp";

/** Default replay window: 5 minutes. */
export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

export type VerifyResult =
  { ok: true } | { ok: false; status: number; code: string; message: string };

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Compute the expected signature for a timestamp + body pair. */
export function signWebhookPayload(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("base64url");
}

/** Build ready-to-send headers (useful for tests and signed outbound calls). */
export function buildWebhookHeaders(
  secret: string,
  rawBody: string,
  now: Date = new Date(),
): Record<string, string> {
  const ts = Math.floor(now.getTime() / 1000).toString();
  return {
    [SIGNATURE_HEADER]: signWebhookPayload(secret, ts, rawBody),
    [TIMESTAMP_HEADER]: ts,
    "content-type": "application/json",
  };
}

/**
 * Verify an inbound webhook request.
 *
 * @param rawBody the EXACT raw body string (await req.text())
 * @param headers request headers
 * @param secret  the shared secret (from env — never from query params)
 */
export function verifyWebhookSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
  toleranceMs: number = DEFAULT_TOLERANCE_MS,
): VerifyResult {
  if (!secret) {
    return {
      ok: false,
      status: 503,
      code: "WEBHOOK_DISABLED",
      message: "Webhook is not configured.",
    };
  }

  const signature = headers.get(SIGNATURE_HEADER);
  const timestamp = headers.get(TIMESTAMP_HEADER);

  if (!signature || !timestamp) {
    return {
      ok: false,
      status: 401,
      code: "MISSING_SIGNATURE",
      message: "Webhook signature headers are required.",
    };
  }

  if (!/^\d{1,13}$/.test(timestamp)) {
    return {
      ok: false,
      status: 401,
      code: "INVALID_TIMESTAMP",
      message: "Invalid webhook timestamp.",
    };
  }

  const tsMs = Number(timestamp) * 1000;
  const skew = Math.abs(Date.now() - tsMs);
  if (skew > toleranceMs) {
    return {
      ok: false,
      status: 401,
      code: "EXPIRED_TIMESTAMP",
      message: "Webhook timestamp is outside the allowed window.",
    };
  }

  const expected = signWebhookPayload(secret, timestamp, rawBody);
  if (!safeEqual(signature, expected)) {
    return {
      ok: false,
      status: 401,
      code: "INVALID_SIGNATURE",
      message: "Invalid webhook signature.",
    };
  }

  return { ok: true };
}

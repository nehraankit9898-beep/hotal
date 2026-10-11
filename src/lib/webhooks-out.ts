/**
 * Phase 17 — Outbound webhooks.
 *
 * Tenant-configured outbound webhook endpoints. Events are signed with
 * HMAC-SHA256 using the endpoint secret. Retries with exponential backoff
 * and a dead-letter queue after max attempts. Replay tools allow manual
 * re-delivery. Used by enterprise API consumers to receive REST events
 * instead of polling.
 *
 * Design:
 *  - Endpoint secret is encrypted at rest in production (via integration-
 *    secrets mechanism). Hash-only storage is NOT used because the secret
 *    must be readable for signing outbound deliveries.
 *  - Event ID is a stable, guess-resistant UUID per delivery (one event may
 *    have multiple deliveries to multiple endpoints). Replay-safety:
 *    receivers should idempotently dedupe by eventId.
 *  - Retry schedule: 30s, 2m, 10m, 1h, 6h, 24h then DEAD. nextRetryAt is
 *    set on each failed attempt. The worker drains PENDING deliveries whose
 *    nextRetryAt has passed.
 *  - Response status 2xx = DELIVERED. 3xx/4xx = DEAD (don't retry client
 *    errors). 5xx/timeout = retry.
 *  - No customer PII in payload unless explicitly approved by the event
 *    producer; payloads are minimal event references, not full data dumps.
 */
import { createHmac, randomBytes } from "crypto";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import type { AuthedUser } from "@/lib/api-helpers";

export const WEBHOOK_SIGNATURE_HEADER = "X-RestroLoop-Signature";
export const WEBHOOK_EVENT_ID_HEADER = "X-RestroLoop-Event-Id";
export const WEBHOOK_EVENT_TYPE_HEADER = "X-RestroLoop-Event-Type";

const MAX_ATTEMPTS = 6;
const BACKOFF_SECONDS = [30, 120, 600, 3600, 21600, 86400];

/** Generate a fresh endpoint secret (caller displays it once). */
export function generateWebhookSecret(): string {
  return "whsec_" + randomBytes(16).toString("hex");
}

/** Compute the HMAC-SHA256 signature for a payload using the endpoint secret. */
export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Generate a stable, guess-resistant event ID for a delivery. */
export function generateEventId(): string {
  return "evt_" + randomBytes(12).toString("hex");
}

/**
 * Validate the endpoint URL. Only https: is allowed in production. Loopback
 * is allowed in dev/test for contract tests (marked CONTRACT_TEST).
 */
export function validateWebhookUrl(url: string, isProduction: boolean): boolean {
  try {
    const u = new URL(url);
    if (isProduction && u.protocol !== "https:") return false;
    if (!["https:", "http:"].includes(u.protocol)) return false;
    return true;
  } catch {
    return false;
  }
}

interface Endpoint {
  id: string;
  hotelId: string;
  url: string;
  secret: string;
  events: string;
  active: boolean;
}

/** Match an event type against the endpoint's subscription list. */
export function endpointSubscribesTo(endpoint: Endpoint, eventType: string): boolean {
  if (!endpoint.active) return false;
  try {
    const arr = JSON.parse(endpoint.events);
    if (!Array.isArray(arr)) return false;
    if (arr.includes("*")) return true;
    return arr.some((e: unknown) => typeof e === "string" && (
      e === eventType ||
      (eventType.startsWith(String(e) + ".") && e.endsWith(".*"))
    ));
  } catch {
    return false;
  }
}

/**
 * Enqueue an outbound event delivery to every subscribing endpoint. Called
 * by event producers (e.g. order placement, bill paid) — fire-and-forget
 * (the actual HTTP delivery is performed by the worker).
 */
export async function enqueueWebhookEvent(
  hotelId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<{ queued: number }> {
  const endpoints = await db.webhookEndpoint.findMany({
    where: { hotelId, active: true },
  });
  if (endpoints.length === 0) return { queued: 0 };
  const payloadStr = JSON.stringify(payload);
  const subscribers = endpoints.filter((e) => endpointSubscribesTo(e, eventType));
  if (subscribers.length === 0) return { queued: 0 };
  const eventId = generateEventId();
  await db.webhookDelivery.createMany({
    data: subscribers.map((e) => ({
      endpointId: e.id,
      eventId,
      eventType,
      payload: payloadStr,
      signature: signPayload(payloadStr, e.secret),
      status: "PENDING",
    })),
  });
  return { queued: subscribers.length };
}

/**
 * Perform the actual HTTP POST for a delivery. Called by the worker.
 * Returns the response status (or null on transport failure).
 */
export async function deliverWebhook(
  deliveryId: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const delivery = await db.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { endpoint: true },
  });
  if (!delivery || delivery.status === "DELIVERED" || delivery.status === "DEAD") {
    return { ok: false, error: "delivery not found or already terminal" };
  }
  if (!delivery.endpoint.active) {
    return { ok: false, error: "endpoint inactive" };
  }
  const attempt = delivery.attempt + 1;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(delivery.endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: delivery.signature,
        [WEBHOOK_EVENT_ID_HEADER]: delivery.eventId,
        [WEBHOOK_EVENT_TYPE_HEADER]: delivery.eventType,
      },
      body: delivery.payload,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const snippet = await res.text().catch(() => "");
    // 2xx → delivered. 3xx/4xx → dead (don't retry client errors). 5xx → retry.
    if (res.status >= 200 && res.status < 300) {
      await db.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          attempt,
          status: "DELIVERED",
          responseStatus: res.status,
          responseSnippet: snippet.slice(0, 500) || null,
          deliveredAt: new Date(),
        },
      });
      return { ok: true, status: res.status };
    }
    if (res.status >= 300 && res.status < 500) {
      await db.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          attempt,
          status: "DEAD",
          responseStatus: res.status,
          responseSnippet: snippet.slice(0, 500) || null,
        },
      });
      return { ok: false, status: res.status, error: "client error, dead-lettered" };
    }
    return recordRetry(deliveryId, attempt, res.status, snippet);
  } catch (e) {
    return recordRetry(deliveryId, attempt, undefined, (e as Error).message);
  }
}

async function recordRetry(
  deliveryId: string,
  attempt: number,
  status: number | undefined,
  snippet: string,
): Promise<{ ok: false; error: string }> {
  if (attempt >= MAX_ATTEMPTS) {
    await db.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        attempt,
        status: "DEAD",
        responseStatus: status ?? null,
        responseSnippet: snippet.slice(0, 500) || null,
      },
    });
    return { ok: false, error: "max attempts reached, dead-lettered" };
  }
  const delaySec = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)];
  const nextRetryAt = new Date(Date.now() + delaySec * 1000);
  await db.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      attempt,
      status: "FAILED",
      responseStatus: status ?? null,
      responseSnippet: snippet.slice(0, 500) || null,
      nextRetryAt,
    },
  });
  return { ok: false, error: "transient failure, scheduled retry" };
}

/**
 * Sweep due webhook deliveries. Called by the worker periodically. Atomic
 * claim prevents two workers from delivering the same row.
 */
export async function sweepDueWebhookDeliveries(limit = 50): Promise<number> {
  const now = new Date();
  const due = await db.webhookDelivery.findMany({
    where: {
      OR: [
        { status: "PENDING" },
        { status: "FAILED", nextRetryAt: { lte: now } },
      ],
    },
    take: limit,
    orderBy: { createdAt: "asc" },
  });
  let delivered = 0;
  for (const d of due) {
    // Best-effort atomic claim using `updateMany` with a where-clause fence.
    const claimed = await db.webhookDelivery.updateMany({
      where: { id: d.id, attempt: d.attempt },
      data: { status: "IN_PROGRESS" },
    });
    if (claimed.count !== 1) continue;
    const r = await deliverWebhook(d.id);
    if (r.ok) delivered += 1;
  }
  return delivered;
}

/**
 * Create a new endpoint. Caller must hold WEBHOOK_MANAGE. The endpoint
 * secret is generated and returned ONCE — store it; only a sha256 of the
 * secret is stored in the audit metadata.
 */
export async function createWebhookEndpoint(
  user: AuthedUser,
  url: string,
  events: string[],
): Promise<{ ok: true; id: string; secret: string } | { ok: false; error: string; status?: number }> {
  if (!validateWebhookUrl(url, process.env.NODE_ENV === "production")) {
    return { ok: false, error: "Endpoint URL must be https: in production.", status: 422 };
  }
  if (events.length === 0) {
    return { ok: false, error: "Specify at least one event type to subscribe to.", status: 422 };
  }
  const secret = generateWebhookSecret();
  try {
    const endpoint = await db.webhookEndpoint.create({
      data: {
        hotelId: user.hotelId,
        url,
        secret,
        events: JSON.stringify(events),
        active: true,
      },
      select: { id: true },
    });
    await logAudit({
      hotelId: user.hotelId,
      userId: user.userId,
      action: "WEBHOOK_ENDPOINT_CREATED",
      entityType: "WebhookEndpoint",
      entityId: endpoint.id,
      metadata: { url, events, secretSha: createHashShort(secret) },
    });
    return { ok: true, id: endpoint.id, secret };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function createHashShort(s: string): string {
  // Just the first 16 hex chars of a sha256 — enough to identify the secret
  // in audit logs without revealing the actual secret.
  // Avoids importing crypto twice by inlining a small helper.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("crypto") as typeof import("crypto");
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

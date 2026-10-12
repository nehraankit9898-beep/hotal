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
 * True for a hostname / IP literal that must never receive webhook traffic in
 * production: loopback, private (RFC 1918 / ULA), link-local (incl. the cloud
 * metadata address 169.254.169.254), CGNAT, multicast/reserved, unspecified,
 * and local-only names. Expects WHATWG-URL-normalised input (`URL.hostname`
 * or a resolved address); a public DNS name returns false here and is
 * re-checked against its resolved addresses at delivery time.
 */
export function isBlockedWebhookHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  // IPv4-mapped IPv6 — dotted (::ffff:10.0.0.1) or URL-normalised hex (::ffff:a00:1).
  const dottedMapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMapped) h = dottedMapped[1];
  const hexMapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    h = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b, c] = h.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast + reserved + broadcast
    );
  }
  if (h.includes(":")) {
    if (h === "::" || h === "::1") return true;
    const first = parseInt(h.split(":")[0] || "0", 16);
    return (
      (first & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
      (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
      (first & 0xff00) === 0xff00 // ff00::/8 multicast
    );
  }
  return false;
}

/**
 * Validate the endpoint URL. Only https: is allowed in production. Loopback
 * is allowed in dev/test for contract tests (marked CONTRACT_TEST).
 *
 * SECURITY FIX: production previously accepted ANY https host, including
 * loopback, private-network and link-local addresses — a tenant admin could
 * point deliveries at the platform's internal network (SSRF).
 */
export function validateWebhookUrl(url: string, isProduction: boolean): boolean {
  try {
    const u = new URL(url);
    if (isProduction && u.protocol !== "https:") return false;
    if (!["https:", "http:"].includes(u.protocol)) return false;
    if (isProduction && isBlockedWebhookHost(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Production delivery-time destination check: the endpoint URL must still
 * validate (endpoints saved before host validation existed) and its hostname
 * must not resolve to a blocked address. Returns the reason, or null if OK.
 * DNS failures throw and are retried like any transport error.
 */
async function blockedDestination(url: string): Promise<string | null> {
  if (!validateWebhookUrl(url, true)) return "destination not allowed (must be a public https URL)";
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const { lookup } = await import("dns/promises");
  const addresses = await lookup(host, { all: true });
  const blocked = addresses.find((a) => isBlockedWebhookHost(a.address));
  return blocked ? `destination resolves to a non-public address (${blocked.address})` : null;
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
    if (process.env.NODE_ENV === "production") {
      const blocked = await blockedDestination(delivery.endpoint.url);
      if (blocked) {
        await db.webhookDelivery.update({
          where: { id: deliveryId },
          data: { attempt, status: "DEAD", responseStatus: null, responseSnippet: blocked },
        });
        return { ok: false, error: "destination blocked, dead-lettered" };
      }
    }
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
      // SECURITY FIX: fetch followed redirects by default, so the 3xx branch
      // below was unreachable and an endpoint could bounce the delivery to
      // any URL — including http:// internal services such as the cloud
      // metadata endpoint. Redirects are now returned and dead-lettered.
      redirect: "manual",
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
    return { ok: false, error: "Endpoint URL must be a public https: URL in production.", status: 422 };
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

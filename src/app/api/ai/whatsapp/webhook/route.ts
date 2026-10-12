import { createHmac, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { decryptCredentials, isEncryptedEnvelope } from "@/lib/crypto";
import { handleInboundWhatsApp } from "@/lib/ai/chatbot";
import { logger } from "@/lib/logger";
import { resolveTenantProvider } from "@/lib/tenant-providers";

/**
 * Phase 18 — Meta WhatsApp inbound webhook for the ordering chatbot.
 *
 * TENANT ROUTING (security-critical): the tenant is resolved from the
 * RECEIVING WhatsApp business number (payload metadata.phone_number_id),
 * matched against tenant WhatsApp integrations' credentials. The customer's
 * message TEXT can never influence tenant selection.
 *
 * SIGNATURE: Meta signs deliveries with X-Hub-Signature-256
 * (= "sha256=" + HMAC-SHA256(appSecret, rawBody)). The app secret comes from
 * the WHATSAPP_APP_SECRET env var. When unset: dev/test accepts with a loud
 * log line (documented dev-only posture); PRODUCTION rejects with 503
 * (fail-closed — no unsigned webhook processing in production).
 *
 * VERIFICATION HANDSHAKE: GET with hub.mode=subscribe & hub.verify_token —
 * the token must equal WHATSAPP_VERIFY_TOKEN; responds with hub.challenge.
 *
 * IDEMPOTENCY: provider message ids are stored on the conversation (unique)
 * — replayed deliveries get 200 but are not re-processed.
 * REPLIES: this route does NOT send outbound messages itself — it returns
 * them to the caller contract as JSON so the Meta "send message" API call
 * happens through the SAME tenant provider pipeline used by campaigns
 * (single messaging engine). The webhook returns {reply} and the calling
 * layer posts it via the tenant's WhatsApp Cloud credentials.
 */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === "subscribe" && expected && token === expected && challenge) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

interface MetaWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string; display_phone_number?: string };
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        messages?: Array<{
          from?: string;
          id?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
}

function verifyMetaSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = header.slice(7);
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  } catch {
    return false;
  }
}

/**
 * Phone-number → tenant cache. PERF FIX: every inbound message used to decrypt
 * the credentials of EVERY tenant's WhatsApp integration. A short TTL keeps the
 * routing correct (a removed integration stops routing within a minute).
 */
const TENANT_CACHE_TTL_MS = 60 * 1000;
const tenantCache = new Map<string, { hotelId: string | null; expiresAt: number }>();

/** Resolve the tenant (hotelId) that owns the receiving WhatsApp number. */
async function resolveTenantByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
  const cached = tenantCache.get(phoneNumberId);
  if (cached && cached.expiresAt > Date.now()) return cached.hotelId;
  const hotelId = await lookupTenantByPhoneNumberId(phoneNumberId);
  tenantCache.set(phoneNumberId, { hotelId, expiresAt: Date.now() + TENANT_CACHE_TTL_MS });
  return hotelId;
}

async function lookupTenantByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
  const integrations = await db.integration.findMany({
    where: { type: "WHATSAPP_CLOUD", enabled: true },
    select: { hotelId: true, credentials: true },
  });
  for (const row of integrations) {
    if (!row.credentials) continue;
    try {
      const creds = isEncryptedEnvelope(row.credentials)
        ? decryptCredentials({ hotelId: row.hotelId, integrationType: "WHATSAPP_CLOUD" }, row.credentials)
        : (JSON.parse(row.credentials) as Record<string, unknown>);
      if (typeof creds.phoneNumberId === "string" && creds.phoneNumberId === phoneNumberId) {
        return row.hotelId;
      }
    } catch {
      continue; // undecryptable row — skip (fail closed per-tenant)
    }
  }
  return null;
}

export async function POST(req: Request) {
  const rawBody = await req.text();

  // --- Signature (fail-closed in production).
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const isProduction = process.env.NODE_ENV === "production";
  if (appSecret) {
    if (!verifyMetaSignature(rawBody, req.headers.get("x-hub-signature-256"), appSecret)) {
      return Response.json({ error: "Invalid signature." }, { status: 401 });
    }
  } else if (isProduction) {
    logger.error("ai.whatsapp_no_app_secret");
    return Response.json({ error: "Webhook secret not configured." }, { status: 503 });
  } else {
    logger.info("ai.whatsapp_signature_skipped_dev");
  }

  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as MetaWebhookPayload;
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const replies: Array<{ phone: string; reply: string }> = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      const messages = value?.messages ?? [];
      if (!phoneNumberId || messages.length === 0) continue; // status updates etc.

      const hotelId = await resolveTenantByPhoneNumberId(phoneNumberId);
      if (!hotelId) {
        logger.info("ai.whatsapp_unknown_number", { phoneNumberIdPrefix: phoneNumberId.slice(0, 6) });
        continue; // not ours / chatbot tenant — 200 so Meta doesn't retry forever
      }

      for (const message of messages) {
        if (message.type !== "text" || !message.text?.body || !message.from) continue;
        const contactName = value?.contacts?.[0]?.profile?.name ?? null;
        const result = await handleInboundWhatsApp({
          hotelId,
          phone: message.from,
          text: message.text.body,
          messageId: message.id ?? undefined,
          customerName: contactName,
        });
        if (result.body) {
          // Diagnostics mirror of the reply (documented response contract).
          // BUG FIX: nothing was ever pushed here after replies moved to the
          // provider pipeline, so `replies` was always empty.
          replies.push({ phone: message.from, reply: result.body });
          // BUG FIX: the reply used to be returned as JSON, which Meta ignores,
          // so customers never received the chatbot's answer. Send it through
          // the tenant's own WhatsApp provider (same pipeline as campaigns).
          try {
            const provider = await resolveTenantProvider(hotelId, "WHATSAPP");
            const sent = await provider.send({ to: message.from, body: result.body });
            if (!sent.ok) {
              logger.warn("ai.whatsapp_reply_failed", { hotelId, error: sent.error ?? "unknown" });
            }
          } catch (err) {
            logger.error("ai.whatsapp_reply_error", { hotelId, error: String(err) });
          }
        }
      }
    }
  }

  // Always 200 to Meta (non-200 causes aggressive retries); processing
  // outcomes are audited inside the engine.
  // `replies` mirrors what was sent (diagnostics). Meta ignores response bodies;
  // the actual delivery happens above through the tenant's provider.
  return Response.json({ received: true, replies });
}

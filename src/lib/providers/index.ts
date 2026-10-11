/**
 * Messaging provider abstraction — Phase 2, extended in Phase 7 with EMAIL.
 *
 * IMPORTANT (per Phase 2 spec): no fake/mock claiming to be real.
 * - The send pipeline is REAL and consent-gated end to end.
 * - When real provider credentials are configured via environment variables,
 *   live adapters (Meta WhatsApp Cloud API / Twilio SMS) are used automatically.
 * - EMAIL (Phase 7) uses the real EmailService: SMTP / AWS SES (SMTP
 *   interface) / Resend / SendGrid via environment config; dev falls back to
 *   a clearly-labeled MOCK adapter.
 * - Without credentials the system runs in clearly-labeled SIMULATION mode:
 *   messages are processed and recorded end-to-end, the provider column says
 *   "SIMULATION", the UI shows a Simulation badge, and NO real message goes out.
 *   Engagement tracking (delivered/opened/clicked) is only ever filled by real
 *   provider webhooks — never fabricated.
 *
 * AUDIT FIX (F03 — WhatsApp marketing adapter completeness): the adapter now
 * supports BOTH message kinds:
 *   - free-form text  → only correct INSIDE the 24-hour customer-service
 *                       window (the caller is responsible for gating);
 *   - APPROVED TEMPLATES (name + language + positional variable components) →
 *     required OUTSIDE the session window (Meta rejects free-form there).
 * `sendTemplate()` is a first-class path and `send()` keeps its text shape so
 * existing callers are unaffected.
 *
 * AUDIT FIX (F04 — honest connection states): `verifyWhatsAppCredentials`,
 * `verifyTwilioCredentials`, `verifyRazorpayCredentials` and
 * `verifyStripeCredentials` perform REAL provider connectivity checks (read-
 * only API calls) so saved integrations can be promoted from
 * SAVED_UNVERIFIED to VERIFIED — or honestly dropped to ERROR — instead of
 * claiming CONNECTED from "the encrypt call did not throw".
 */
import {
  getEmailProvider,
  sendEmailWithRetry,
  emailTransportStatus,
  type EmailProvider,
  type EmailTransportStatus,
} from "./email";

export type Channel = "WHATSAPP" | "SMS" | "EMAIL";

/** F03 — a bound, provider-approved template message (usable 24/7). */
export interface TemplatePayload {
  /** Provider-side template NAME (Meta) — must be APPROVED. */
  name: string;
  /** BCP-47 language code of the APPROVED template, e.g. "en", "en_US", "hi". */
  languageCode: string;
  /**
   * Positional variable values for {{1}}, {{2}}, … (Meta components). Keys are
   * positions ("1", "2", …); values are the resolved strings.
   */
  variables?: Record<string, string>;
}

export interface OutboundMessage {
  to: string; // normalized phone (WhatsApp/SMS) or email
  body: string;
  /** When set, the provider sends the APPROVED TEMPLATE instead of free text. */
  template?: TemplatePayload;
}

export interface SendResult {
  ok: boolean;
  provider: string; // e.g. WHATSAPP_CLOUD, TWILIO_SMS, SIMULATION
  providerMessageId?: string;
  error?: string;
  /** "TEMPLATE" when an approved template was used, "TEXT" for free-form. */
  kind?: "TEMPLATE" | "TEXT";
}

export interface MessageProvider {
  readonly id: string;
  readonly channel: Channel;
  send(msg: OutboundMessage): Promise<SendResult>;
}

/* ------------------------------------------------------------------ */
/* Live provider: Meta WhatsApp Cloud API                              */
/* ------------------------------------------------------------------ */
export class WhatsAppCloudProvider implements MessageProvider {
  readonly id = "WHATSAPP_CLOUD";
  readonly channel: Channel = "WHATSAPP";

  constructor(
    private token: string,
    private phoneNumberId: string,
  ) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    try {
      // F03: approved template message (works outside the 24h window).
      if (msg.template) {
        return await this.sendTemplateMessage(msg);
      }
      // F03 (honesty): free-form text is only deliverable inside WhatsApp's
      // customer-service window. The caller decides eligibility; the adapter
      // labels the kind so receipts/records can show what was attempted.
      return await this.sendTextMessage(msg);
    } catch (err) {
      return {
        ok: false,
        provider: this.id,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }

  private async sendTextMessage(msg: OutboundMessage): Promise<SendResult> {
    const res = await fetch(`https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: msg.to.replace(/^\+/, ""),
        type: "text",
        text: { preview_url: true, body: msg.body },
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      messages?: { id: string }[];
      error?: { message?: string };
    };
    if (!res.ok) {
      return {
        ok: false,
        provider: this.id,
        kind: "TEXT",
        error: data.error?.message ?? `WhatsApp API error ${res.status}`,
      };
    }
    return { ok: true, provider: this.id, providerMessageId: data.messages?.[0]?.id, kind: "TEXT" };
  }

  private async sendTemplateMessage(msg: OutboundMessage): Promise<SendResult> {
    const t = msg.template!;
    const variables = t.variables ?? {};
    const positions = Object.keys(variables).sort((a, b) => Number(a) - Number(b));
    const components: unknown[] = [];
    if (positions.length > 0) {
      components.push({
        type: "body",
        parameters: positions.map((p) => ({ type: "text", text: variables[p] })),
      });
    }
    const res = await fetch(`https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: msg.to.replace(/^\+/, ""),
        type: "template",
        template: {
          name: t.name,
          language: { code: t.languageCode },
          ...(components.length ? { components } : {}),
        },
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      messages?: { id: string }[];
      error?: { message?: string; code?: number };
    };
    if (!res.ok) {
      // Common failure: template not approved / wrong language — surface it
      // honestly instead of silently falling back to free-form (which Meta
      // would reject outside the session window anyway).
      return {
        ok: false,
        provider: this.id,
        kind: "TEMPLATE",
        error: data.error?.message ?? `WhatsApp template error ${res.status}`,
      };
    }
    return {
      ok: true,
      provider: this.id,
      providerMessageId: data.messages?.[0]?.id,
      kind: "TEMPLATE",
    };
  }
}

/* ------------------------------------------------------------------ */
/* Live provider: Twilio SMS                                           */
/* ------------------------------------------------------------------ */
export class TwilioSmsProvider implements MessageProvider {
  readonly id = "TWILIO_SMS";
  readonly channel: Channel = "SMS";

  constructor(
    private accountSid: string,
    private authToken: string,
    private fromNumber: string,
  ) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            To: msg.to,
            From: this.fromNumber,
            Body: msg.body,
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (!res.ok) {
        return {
          ok: false,
          provider: this.id,
          error: data.message ?? `Twilio error ${res.status}`,
        };
      }
      return { ok: true, provider: this.id, providerMessageId: data.sid };
    } catch (err) {
      return {
        ok: false,
        provider: this.id,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Simulation provider — used ONLY when no live credentials exist      */
/* ------------------------------------------------------------------ */
export class SimulationProvider implements MessageProvider {
  readonly id = "SIMULATION";
  readonly channel: Channel;

  constructor(channel: Channel) {
    this.channel = channel;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const id = `SIM-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (!msg.to || (!msg.body && !msg.template)) {
      return { ok: false, provider: this.id, error: "Missing recipient or message body" };
    }
    // Honest simulation: record WHICH kind would have gone out.
    return {
      ok: true,
      provider: this.id,
      providerMessageId: id,
      kind: msg.template ? "TEMPLATE" : "TEXT",
    };
  }
}

/* ------------------------------------------------------------------ */
/* Phase 7 — EMAIL channel adapter (wraps the real EmailService)       */
/* ------------------------------------------------------------------ */
class EmailChannelProvider implements MessageProvider {
  readonly id: string;
  readonly channel: Channel = "EMAIL";

  constructor(private emailProvider: EmailProvider) {
    this.id = emailProvider.id;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const result = await sendEmailWithRetry({
      to: msg.to,
      subject: "A message from your hotel",
      html: `<p>${msg.body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>")}</p>`,
      text: msg.body,
      kind: "campaign",
    });
    return {
      ok: result.ok,
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      error: result.error,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Resolver                                                            */
/* ------------------------------------------------------------------ */

export interface ProviderStatus {
  mode: "SIMULATION" | "LIVE";
  whatsapp: boolean; // live credentials present?
  sms: boolean;
  email: EmailTransportStatus; // real email transport? (smtp | aws_ses | resend | sendgrid | mock | unconfigured)
}

export function providerStatus(): ProviderStatus {
  const whatsapp = Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
  const sms = Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER,
  );
  const email = emailTransportStatus();
  return {
    mode:
      whatsapp ||
      sms ||
      email === "smtp" ||
      email === "aws_ses" ||
      email === "resend" ||
      email === "sendgrid"
        ? "LIVE"
        : "SIMULATION",
    whatsapp,
    sms,
    email,
  };
}

export function getProvider(channel: Channel): MessageProvider {
  const status = providerStatus();
  if (channel === "WHATSAPP" && status.whatsapp) {
    return new WhatsAppCloudProvider(
      process.env.WHATSAPP_TOKEN!,
      process.env.WHATSAPP_PHONE_NUMBER_ID!,
    );
  }
  if (channel === "SMS" && status.sms) {
    return new TwilioSmsProvider(
      process.env.TWILIO_ACCOUNT_SID!,
      process.env.TWILIO_AUTH_TOKEN!,
      process.env.TWILIO_FROM_NUMBER!,
    );
  }
  if (channel === "EMAIL") {
    // Phase 7: real EmailService (SMTP / AWS SES / Resend / SendGrid) when
    // configured; mock adapter in dev/test; unconfigured production surfaces
    // the "MOCK_EMAIL" provider id honestly (never fake-labeled as sent).
    return new EmailChannelProvider(getEmailProvider());
  }
  return new SimulationProvider(channel);
}

/* ------------------------------------------------------------------ */
/* AUDIT FIX (F04) — REAL credential verification helpers.             */
/* Read-only provider calls used by the integration verify flow.       */
/* ------------------------------------------------------------------ */

export interface CredentialVerifyResult {
  ok: boolean;
  /** e.g. WHATSAPP_CLOUD / TWILIO_SMS — the live provider that answered. */
  providerId?: string;
  /** Human-readable detail (never includes secrets). */
  detail?: string;
}

export async function verifyWhatsAppCredentials(
  token: string,
  phoneNumberId: string,
): Promise<CredentialVerifyResult> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}?fields=id,display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      display_phone_number?: string;
      verified_name?: string;
      error?: { message?: string };
    };
    if (!res.ok) {
      return { ok: false, detail: data.error?.message ?? `WhatsApp API error ${res.status}` };
    }
    return {
      ok: true,
      providerId: "WHATSAPP_CLOUD",
      detail: data.verified_name
        ? `Connected to ${data.verified_name} (${data.display_phone_number ?? data.id})`
        : `Connected to WhatsApp number ${data.display_phone_number ?? data.id}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "Network error" };
  }
}

export async function verifyTwilioCredentials(
  accountSid: string,
  authToken: string,
): Promise<CredentialVerifyResult> {
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      },
    });
    const data = (await res.json().catch(() => ({}))) as {
      friendly_name?: string;
      status?: string;
      message?: string;
    };
    if (!res.ok) {
      return { ok: false, detail: data.message ?? `Twilio API error ${res.status}` };
    }
    return {
      ok: true,
      providerId: "TWILIO_SMS",
      detail: `Twilio account ${data.friendly_name ?? accountSid} (${data.status ?? "active"})`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "Network error" };
  }
}

export async function verifyRazorpayCredentials(
  keyId: string,
  keySecret: string,
): Promise<CredentialVerifyResult> {
  try {
    const res = await fetch("https://api.razorpay.com/v1/payments?count=1", {
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      },
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: { description?: string } };
      return { ok: false, detail: data.error?.description ?? `Razorpay API error ${res.status}` };
    }
    return {
      ok: true,
      providerId: "RAZORPAY",
      detail: "Razorpay key pair authenticated (payments read OK)",
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "Network error" };
  }
}

export async function verifyStripeCredentials(secretKey: string): Promise<CredentialVerifyResult> {
  try {
    const res = await fetch("https://api.stripe.com/v1/balance", {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return { ok: false, detail: data.error?.message ?? `Stripe API error ${res.status}` };
    }
    return {
      ok: true,
      providerId: "STRIPE",
      detail: "Stripe secret key authenticated (balance read OK)",
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "Network error" };
  }
}

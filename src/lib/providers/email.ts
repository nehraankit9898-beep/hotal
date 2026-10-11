/**
 * Phase 7 — real email provider abstraction (`EmailService`).
 *
 * Architecture (per Phase 7 spec §8):
 *
 *   EmailService (sendEmail + retry + timeout + delivery logging)
 *   ├── SMTP          — any RFC-5321 server via nodemailer (SMTP_URL)
 *   ├── AWS SES       — via the SES SMTP interface (SMTP_URL with SES creds)
 *   ├── Resend        — HTTPS API (RESEND_API_KEY)
 *   ├── SendGrid      — HTTPS API (SENDGRID_API_KEY)
 *   └── Mock          — dev/test only: captures mail in memory (never sends)
 *
 * Rules:
 * - Provider credentials come from environment variables only. Never hardcoded.
 * - Every send: timeout, retries with backoff, structured delivery logging.
 * - No fabricated success: errors are surfaced honestly to the caller.
 * - Development keeps a mock adapter so local flows work without credentials.
 */

import { logger } from "@/lib/logger";
import { isProduction } from "@/lib/config";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /** Logical kind, used for logging/metrics only (verification, reset, campaign). */
  kind?: string;
}

export interface EmailSendResult {
  ok: boolean;
  provider: string;
  providerMessageId?: string;
  error?: string;
}

export interface EmailProvider {
  readonly id: string;
  sendEmail(msg: EmailMessage): Promise<EmailSendResult>;
}

/* ------------------------------------------------------------------ */
/* Adapter: SMTP (nodemailer) — also covers AWS SES SMTP interface     */
/* ------------------------------------------------------------------ */

class SmtpEmailProvider implements EmailProvider {
  readonly id: string;

  constructor(
    private url: string,
    private from: string,
    private host: string,
  ) {
    // Label SES explicitly so delivery logs show the real transport.
    this.id = /email-smtp\.(.+)\.amazonaws\.com/.test(host) ? "AWS_SES_SMTP" : "SMTP";
  }

  async sendEmail(msg: EmailMessage): Promise<EmailSendResult> {
    try {
      const nodemailer = await import("nodemailer");
      const transport = nodemailer.createTransport({
        url: this.url,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      } as never);
      const info = await transport.sendMail({
        from: this.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        replyTo: msg.replyTo,
      });
      return { ok: true, provider: this.id, providerMessageId: info.messageId };
    } catch (err) {
      return {
        ok: false,
        provider: this.id,
        error: err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : "SMTP error",
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Adapter: Resend (HTTPS API)                                         */
/* ------------------------------------------------------------------ */

class ResendEmailProvider implements EmailProvider {
  readonly id = "RESEND";

  constructor(
    private apiKey: string,
    private from: string,
  ) {}

  async sendEmail(msg: EmailMessage): Promise<EmailSendResult> {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          reply_to: msg.replyTo,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok) {
        return {
          ok: false,
          provider: this.id,
          error: data.message ?? `Resend error ${res.status}`,
        };
      }
      return { ok: true, provider: this.id, providerMessageId: data.id };
    } catch (err) {
      return {
        ok: false,
        provider: this.id,
        error: err instanceof Error ? err.message : "Resend network error",
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Adapter: SendGrid (HTTPS API)                                       */
/* ------------------------------------------------------------------ */

class SendGridEmailProvider implements EmailProvider {
  readonly id = "SENDGRID";

  constructor(
    private apiKey: string,
    private from: string,
  ) {}

  async sendEmail(msg: EmailMessage): Promise<EmailSendResult> {
    try {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: msg.to }] }],
          from: { email: this.extractAddress(this.from) },
          subject: msg.subject,
          content: [
            { type: "text/plain", value: msg.text },
            { type: "text/html", value: msg.html },
          ],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { errors?: { message?: string }[] };
        return {
          ok: false,
          provider: this.id,
          error: body.errors?.[0]?.message ?? `SendGrid error ${res.status}`,
        };
      }
      return {
        ok: true,
        provider: this.id,
        providerMessageId: res.headers.get("x-message-id") ?? undefined,
      };
    } catch (err) {
      return {
        ok: false,
        provider: this.id,
        error: err instanceof Error ? err.message : "SendGrid network error",
      };
    }
  }

  private extractAddress(from: string): string {
    const m = from.match(/<([^>]+)>/);
    return m ? m[1] : from;
  }
}

/* ------------------------------------------------------------------ */
/* Adapter: Unconfigured (production fail-closed)                      */
/* ------------------------------------------------------------------ */

/**
 * Production with no real provider: delivery FAILS explicitly instead of
 * silently succeeding through the mock (audit fix — a mock "delivery"
 * reported success for real verification/reset emails). Callers surface
 * the error honestly; no email is ever fabricated as sent.
 */
class UnconfiguredEmailProvider implements EmailProvider {
  readonly id = "UNCONFIGURED";

  async sendEmail(_msg: EmailMessage): Promise<EmailSendResult> {
    return {
      ok: false,
      provider: this.id,
      error:
        "Email delivery is not configured: set EMAIL_PROVIDER and one of SMTP_URL / RESEND_API_KEY / SENDGRID_API_KEY (mock is dev/test only).",
    };
  }
}

/* ------------------------------------------------------------------ */
/* Adapter: Mock (development / test ONLY)                             */
/* ------------------------------------------------------------------ */

export interface CapturedEmail extends EmailMessage {
  ts: string;
  provider: string;
  providerMessageId: string;
}

interface MockOutbox {
  emails: CapturedEmail[];
}

declare global {
  var __stayloopEmailOutbox: MockOutbox | undefined;
}

function outbox(): MockOutbox {
  if (!globalThis.__stayloopEmailOutbox) globalThis.__stayloopEmailOutbox = { emails: [] };
  return globalThis.__stayloopEmailOutbox;
}

export class MockEmailProvider implements EmailProvider {
  readonly id = "MOCK_EMAIL";

  async sendEmail(msg: EmailMessage): Promise<EmailSendResult> {
    const id = `MOCK-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const box = outbox();
    box.emails.push({
      ...msg,
      ts: new Date().toISOString(),
      provider: this.id,
      providerMessageId: id,
    });
    // Bound memory in long-running dev sessions.
    if (box.emails.length > 200) box.emails.splice(0, box.emails.length - 200);
    logger.info("email.mock_delivered", { kind: msg.kind, to: msg.to, subject: msg.subject });
    return { ok: true, provider: this.id, providerMessageId: id };
  }
}

/** Test helper — read (and optionally clear) the captured mock emails. */
export function getMockOutbox(): CapturedEmail[] {
  return outbox().emails;
}
export function clearMockOutbox(): void {
  outbox().emails = [];
}

/* ------------------------------------------------------------------ */
/* Resolver + retry wrapper (the "EmailService")                       */
/* ------------------------------------------------------------------ */

function defaultFrom(): string {
  return (process.env.EMAIL_FROM || "").trim() || "StayLoop <no-reply@stayloop.local>";
}

export type EmailTransportStatus =
  "mock" | "smtp" | "aws_ses" | "resend" | "sendgrid" | "unconfigured";

/** Which transport would be used right now (for health + status display). */
export function emailTransportStatus(): EmailTransportStatus {
  const explicit = (process.env.EMAIL_PROVIDER || "auto").trim().toLowerCase();
  const smtpUrl = (process.env.SMTP_URL || "").trim();
  const resend = (process.env.RESEND_API_KEY || "").trim();
  const sendgrid = (process.env.SENDGRID_API_KEY || "").trim();

  const pickSmtp = explicit === "smtp" || (explicit === "auto" && smtpUrl);
  const pickResend = explicit === "resend" || (explicit === "auto" && !smtpUrl && resend);
  const pickSendgrid =
    explicit === "sendgrid" || (explicit === "auto" && !smtpUrl && !resend && sendgrid);

  if (pickSmtp && smtpUrl) {
    const hostMatch = smtpUrl.match(/@([^:/?]+)/);
    const host = hostMatch ? hostMatch[1] : "";
    return /email-smtp\.(.+)\.amazonaws\.com/.test(host) ? "aws_ses" : "smtp";
  }
  if (pickResend && resend) return "resend";
  if (pickSendgrid && sendgrid) return "sendgrid";
  if (isProduction()) return "unconfigured";
  return "mock";
}

/**
 * The provider that would send right now.
 * Production + no provider → UnconfiguredEmailProvider (explicit failure,
 * never a silent mock). Development/test + no provider → the mock outbox.
 */
export function getEmailProvider(): EmailProvider {
  const explicit = (process.env.EMAIL_PROVIDER || "auto").trim().toLowerCase();
  const smtpUrl = (process.env.SMTP_URL || "").trim();
  const resend = (process.env.RESEND_API_KEY || "").trim();
  const sendgrid = (process.env.SENDGRID_API_KEY || "").trim();
  const from = defaultFrom();

  const useSmtp = explicit === "smtp" || (explicit === "auto" && Boolean(smtpUrl));
  const useResend = explicit === "resend" || (explicit === "auto" && !smtpUrl && Boolean(resend));
  const useSendgrid =
    explicit === "sendgrid" || (explicit === "auto" && !smtpUrl && !resend && Boolean(sendgrid));

  if (useSmtp && smtpUrl) {
    const hostMatch = smtpUrl.match(/@([^:/?]+)/);
    return new SmtpEmailProvider(smtpUrl, from, hostMatch ? hostMatch[1] : "");
  }
  if (useResend && resend) return new ResendEmailProvider(resend, from);
  if (useSendgrid && sendgrid) return new SendGridEmailProvider(sendgrid, from);

  if (isProduction()) {
    // Production without a provider: every send fails loudly and honestly.
    return new UnconfiguredEmailProvider();
  }
  return new MockEmailProvider();
}

const EMAIL_RETRY_ATTEMPTS = 3;
const EMAIL_RETRY_BASE_DELAY_MS = 1000;

/**
 * Send an email with timeout + exponential backoff retries + delivery logging.
 * Returns the final result honestly — no fabricated success. An unconfigured
 * production provider short-circuits (retrying a configuration error is
 * pointless and would only delay the honest failure).
 */
export async function sendEmailWithRetry(msg: EmailMessage): Promise<EmailSendResult> {
  const provider = getEmailProvider();
  if (provider.id === "UNCONFIGURED") {
    logger.error("email.unconfigured", { kind: msg.kind });
    return provider.sendEmail(msg);
  }
  let last: EmailSendResult = { ok: false, provider: provider.id, error: "not attempted" };

  for (let attempt = 1; attempt <= EMAIL_RETRY_ATTEMPTS; attempt++) {
    last = await provider.sendEmail(msg);
    if (last.ok) {
      logger.info("email.delivered", {
        kind: msg.kind,
        provider: last.provider,
        attempt,
        providerMessageId: last.providerMessageId,
      });
      return last;
    }
    logger.warn("email.delivery_failed", {
      kind: msg.kind,
      provider: last.provider,
      attempt,
      error: last.error,
    });
    if (attempt < EMAIL_RETRY_ATTEMPTS) {
      const delay = EMAIL_RETRY_BASE_DELAY_MS * Math.pow(4, attempt - 1); // 1s, 4s
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  logger.error("email.delivery_exhausted", { kind: msg.kind, provider: last.provider });
  return last;
}

/** Branded HTML template wrapper for transactional emails. */
export function renderEmailTemplate(
  title: string,
  bodyHtml: string,
): { html: string; text: string } {
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px;">
        <tr><td style="font-size:20px;font-weight:bold;color:#111827;padding-bottom:8px;">StayLoop</td></tr>
        <tr><td style="font-size:16px;font-weight:600;color:#111827;padding-bottom:16px;">${escapeHtml(title)}</td></tr>
        <tr><td style="font-size:14px;line-height:1.6;color:#374151;">${bodyHtml}</td></tr>
        <tr><td style="font-size:12px;color:#9ca3af;padding-top:24px;border-top:1px solid #e5e7eb;">
          If you did not request this email, you can safely ignore it.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  const text = `${title}\n\n${htmlToText(bodyHtml)}\n\nIf you did not request this email, you can safely ignore it.`;
  return { html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

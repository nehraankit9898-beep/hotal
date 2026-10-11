/**
 * Phase 7 — transactional email builders for verification & password reset.
 *
 * Uses the EmailService (SMTP / AWS SES / Resend / SendGrid / mock). Links are
 * built from APP_ORIGIN (validated by env.ts). In non-production, when no real
 * provider is configured, the mock adapter captures the email and the raw link
 * is ALSO logged via logger.debug so local flows remain testable — production
 * never logs links (they carry one-time tokens).
 */

import { appOrigin, requireEmailVerification } from "@/lib/env";
import {
  renderEmailTemplate,
  sendEmailWithRetry,
  type EmailSendResult,
} from "@/lib/providers/email";
import { logger } from "@/lib/logger";
import { isProduction } from "@/lib/config";

function safeOrigin(): string {
  const origin = appOrigin();
  if (!origin) return "";
  return origin.replace(/\/+$/, "");
}

/** Build the absolute verification URL. Empty string when origin is unknown. */
export function buildVerificationUrl(token: string): string {
  const origin = safeOrigin();
  return origin ? `${origin}/verify-email?token=${encodeURIComponent(token)}` : "";
}

/** Build the absolute password reset URL. Empty string when origin is unknown. */
export function buildResetUrl(token: string): string {
  const origin = safeOrigin();
  return origin ? `${origin}/reset-password?token=${encodeURIComponent(token)}` : "";
}

function linkBlock(url: string, label: string): string {
  return `<p style="margin:24px 0;"><a href="${url}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">${label}</a></p>
  <p style="font-size:12px;color:#6b7280;">Or paste this link into your browser:<br/>${url}</p>`;
}

export async function sendVerificationEmail(
  to: string,
  token: string,
): Promise<EmailSendResult & { url: string }> {
  const url = buildVerificationUrl(token);
  const { html, text } = renderEmailTemplate(
    "Verify your email address",
    `<p>Welcome to StayLoop! Please confirm your email address to activate your account.</p>${
      url
        ? linkBlock(url, "Verify email")
        : "<p>Your verification link could not be generated — please contact support.</p>"
    }<p>This link expires in 24 hours and can be used once.</p>`,
  );

  const result = await sendEmailWithRetry({
    to,
    subject: "Verify your StayLoop email address",
    html,
    text,
    kind: "verification",
  });

  if (!isProduction() && url) {
    // Dev/test convenience only — never in production.
    logger.debug("email.verification_link_dev", { to, url });
  }
  return { ...result, url };
}

/**
 * Sent to the owner of an address that someone tried to register again.
 * Used instead of telling the requester "this email exists" (enumeration fix).
 */
export async function sendAccountExistsEmail(to: string): Promise<EmailSendResult> {
  const origin = safeOrigin();
  const signIn = origin ? linkBlock(`${origin}/`, "Sign in") : "";
  const { html, text } = renderEmailTemplate(
    "You already have a StayLoop account",
    `<p>Someone tried to register a new StayLoop account with this email address.</p>` +
      `<p>If that was you, sign in instead. If it wasn't, you can ignore this message — your account has not changed.</p>${signIn}`,
  );
  return sendEmailWithRetry({
    to,
    subject: "StayLoop: you already have an account",
    html,
    text,
    kind: "account-exists",
  });
}

export async function sendPasswordResetEmail(
  to: string,
  token: string,
): Promise<EmailSendResult & { url: string }> {
  const url = buildResetUrl(token);
  const { html, text } = renderEmailTemplate(
    "Reset your password",
    `<p>We received a request to reset your StayLoop password.</p>${
      url
        ? linkBlock(url, "Choose a new password")
        : "<p>Your reset link could not be generated — please contact support.</p>"
    }<p>This link expires in 1 hour and can be used once. If you did not request a reset, you can safely ignore this email — your password stays unchanged.</p>`,
  );

  const result = await sendEmailWithRetry({
    to,
    subject: "Reset your StayLoop password",
    html,
    text,
    kind: "password_reset",
  });

  if (!isProduction() && url) {
    logger.debug("email.reset_link_dev", { to, url });
  }
  return { ...result, url };
}

/** Whether login must be blocked until the address is verified. */
export function loginRequiresVerification(): boolean {
  return requireEmailVerification();
}

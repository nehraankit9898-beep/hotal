/**
 * Phase 7 — strict runtime environment validation (`src/lib/env.ts`).
 *
 * This module is the SINGLE source of truth for every environment variable the
 * application reads. It complements `src/lib/config.ts` (which owns the core
 * secrets) by validating ALL remaining variables — including optional ones —
 * so that a typo'd URL or an invalid number fails loudly at startup instead of
 * silently misbehaving in production.
 *
 * Rules (per Phase 7 spec §3):
 * - Production FAILS CLOSED when a required variable is missing or invalid.
 * - Placeholder / dev / sample secret values are always rejected.
 * - Safe error messages: never echo secret VALUES, only names and reasons.
 * - Development/test get safe, clearly-labeled defaults so local dev works.
 */

import { z } from "zod";
import { isProduction, isTest, MIN_SECRET_LENGTH, ConfigValidationError } from "./config";

/* ------------------------------------------------------------------ */
/* Primitive validators                                                */
/* ------------------------------------------------------------------ */

const urlSchema = z.string().trim().url("must be a valid absolute URL");

const httpsUrlSchema = z
  .string()
  .trim()
  .url("must be a valid absolute URL")
  .refine((v) => v.startsWith("https://") || v.startsWith("http://localhost"), {
    message: "must use https:// in production",
  });

const redisUrlSchema = z
  .string()
  .trim()
  .refine((v) => /^rediss?:\/\//.test(v), {
    message: "must start with redis:// or rediss://",
  });

const smtpUrlSchema = z
  .string()
  .trim()
  .refine((v) => /^smtps?:\/\//.test(v), {
    message: "must start with smtp:// or smtps://",
  });

const emailFromSchema = z
  .string()
  .trim()
  .min(3)
  .refine((v) => /<[^>]+@[^>]+>|^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), {
    message: 'must be "Name <addr@domain>" or "addr@domain"',
  });

const boolSchema = z
  .string()
  .refine((v) => ["true", "false", "1", "0", "yes", "no"].includes(v.trim().toLowerCase()), {
    message: "must be true/false (or 1/0, yes/no)",
  });

const positiveIntSchema = z.string().refine((v) => /^\d+$/.test(v.trim()) && Number(v) > 0, {
  message: "must be a positive integer",
});

const nonNegativeNumberSchema = z
  .string()
  .refine((v) => !Number.isNaN(Number(v)) && Number(v) >= 0, {
    message: "must be a non-negative number",
  });

const originListSchema = z.string().refine(
  (v) =>
    v
      .split(/[\s,]+/)
      .filter(Boolean)
      .every((o) => o === "*" || o === "'self'" || /^https?:\/\//.test(o)),
  { message: "must be space/comma-separated origins (https://…), 'self', or *" },
);

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

const emailProviderSchema = z.enum(["smtp", "resend", "sendgrid", "auto", "mock"]);

/* ------------------------------------------------------------------ */
/* Optional-but-validated variables                                    */
/* ------------------------------------------------------------------ */

interface OptionalSpec {
  name: string;
  schema: z.ZodTypeAny;
  /** Description used in error messages and docs. */
  purpose: string;
}

const OPTIONAL_VARS: OptionalSpec[] = [
  {
    name: "REDIS_URL",
    schema: redisUrlSchema,
    purpose: "distributed rate limiting / queue coordination",
  },
  {
    name: "EMAIL_PROVIDER",
    schema: emailProviderSchema,
    purpose: "email transport selection (smtp|resend|sendgrid|auto|mock)",
  },
  {
    name: "SMTP_URL",
    schema: smtpUrlSchema,
    purpose: "SMTP transport endpoint (also used for AWS SES via SES SMTP interface)",
  },
  { name: "EMAIL_FROM", schema: emailFromSchema, purpose: "From header for outgoing emails" },
  {
    name: "RESEND_API_KEY",
    schema: z.string().min(20, "must be a valid API key"),
    purpose: "Resend email transport",
  },
  {
    name: "SENDGRID_API_KEY",
    schema: z.string().min(20, "must be a valid API key"),
    purpose: "SendGrid email transport",
  },
  {
    name: "APP_ORIGIN",
    schema: urlSchema,
    purpose: "public origin used to build verification / reset links",
  },
  {
    name: "FRONTEND_URL",
    schema: urlSchema,
    purpose: "public origin fallback (legacy alias of APP_ORIGIN)",
  },
  {
    name: "BOOKING_LINK",
    schema: urlSchema,
    purpose: "booking funnel link attributed in campaigns",
  },
  {
    name: "COST_PER_MESSAGE",
    schema: nonNegativeNumberSchema,
    purpose: "per-message cost used in ROI analytics",
  },
  {
    name: "TRUSTED_ORIGINS",
    schema: originListSchema,
    purpose: "extra origins allowed for CSRF/CORS",
  },
  {
    name: "EMBED_FRAME_ANCESTORS",
    schema: originListSchema,
    purpose: "CSP frame-ancestors allowlist for trusted embedding",
  },
  {
    name: "REQUIRE_EMAIL_VERIFICATION",
    schema: boolSchema,
    purpose: "block login until the email address is verified",
  },
  {
    name: "INLINE_SEND_THRESHOLD",
    schema: positiveIntSchema,
    purpose: "campaign audiences above this size are queued (default 25)",
  },
  {
    name: "EXPORT_INLINE_MAX_ROWS",
    schema: positiveIntSchema,
    purpose: "CSV exports above this row count are queued (default 5000)",
  },
  {
    name: "LOG_LEVEL",
    schema: logLevelSchema,
    purpose: "structured log verbosity (debug|info|warn|error)",
  },
  {
    name: "WHATSAPP_TOKEN",
    schema: z.string().min(16, "must be a valid access token"),
    purpose: "WhatsApp Cloud API credentials",
  },
  {
    name: "WHATSAPP_PHONE_NUMBER_ID",
    schema: z.string().min(3),
    purpose: "WhatsApp Cloud API phone number id",
  },
  {
    name: "TWILIO_ACCOUNT_SID",
    schema: z.string().regex(/^AC[a-zA-Z0-9]{10,}$/, "must be a Twilio Account SID (AC…)"),
    purpose: "Twilio SMS credentials",
  },
  {
    name: "TWILIO_AUTH_TOKEN",
    schema: z.string().min(16, "must be a valid auth token"),
    purpose: "Twilio SMS credentials",
  },
  { name: "TWILIO_FROM_NUMBER", schema: z.string().min(6), purpose: "Twilio sender number" },
  {
    name: "GATEWAY_PUBLIC_SUFFIX",
    schema: z.string().min(1),
    purpose: "preview gateway host suffix used by the CSRF host allowlist",
  },
];

/** Values that are obviously placeholders — rejected in EVERY environment. */
const PLACEHOLDER_VALUES = new Set([
  "change-me",
  "changeme",
  "CHANGEME",
  "your-api-key-here",
  "your_api_key",
  "xxx",
  "placeholder",
  "re_123456789012345678901234567890", // resend docs sample
  "SG.xxxxxxxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
]);

/* ------------------------------------------------------------------ */
/* Typed accessors (safe to call at request time)                      */
/* ------------------------------------------------------------------ */

export function appOrigin(): string {
  const v = process.env.APP_ORIGIN || process.env.FRONTEND_URL || "";
  if (v) return v.replace(/\/+$/, "");
  if (isProduction()) {
    // Fail closed: without a public origin, verification/reset links cannot be
    // built. Callers must not fabricate links.
    return "";
  }
  return "http://localhost:3000";
}

export function requireEmailVerification(): boolean {
  const v = (process.env.REQUIRE_EMAIL_VERIFICATION || "").trim().toLowerCase();
  if (!v) return false; // default off — registration keeps working out of the box
  return v === "true" || v === "1" || v === "yes";
}

export function inlineSendThreshold(): number {
  const n = Number(process.env.INLINE_SEND_THRESHOLD || "25");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 25;
}

export function exportInlineMaxRows(): number {
  const n = Number(process.env.EXPORT_INLINE_MAX_ROWS || "5000");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5000;
}

export function redisUrl(): string {
  return (process.env.REDIS_URL || "").trim();
}

/* ------------------------------------------------------------------ */
/* Startup validation                                                  */
/* ------------------------------------------------------------------ */

export interface EnvValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate every declared optional variable IF it is set. Invalid values are
 * accumulated (all findings reported at once). Secret-valued variables are
 * checked for placeholder values without ever printing the value itself.
 */
export function validateExtendedEnv(): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const spec of OPTIONAL_VARS) {
    const raw = process.env[spec.name];
    if (raw === undefined || raw.trim() === "") continue;
    const parsed = spec.schema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0]?.message ?? "invalid value";
      errors.push(`${spec.name} ${first} (${spec.purpose})`);
      continue;
    }
    // Secret-shaped values: reject placeholders anywhere, and reject weak
    // values in production.
    if (/API_KEY|TOKEN|SECRET/i.test(spec.name)) {
      if (PLACEHOLDER_VALUES.has(raw.trim())) {
        errors.push(`${spec.name} is set to a placeholder value and is rejected.`);
        continue;
      }
      if (
        isProduction() &&
        raw.trim().length < MIN_SECRET_LENGTH &&
        spec.name !== "WHATSAPP_PHONE_NUMBER_ID"
      ) {
        warnings.push(
          `${spec.name} looks shorter than the recommended ${MIN_SECRET_LENGTH} characters for production.`,
        );
      }
    }
  }

  // Cross-field rules
  const provider = (process.env.EMAIL_PROVIDER || "auto").trim().toLowerCase();
  const hasSmtp = Boolean((process.env.SMTP_URL || "").trim());
  const hasResend = Boolean((process.env.RESEND_API_KEY || "").trim());
  const hasSendgrid = Boolean((process.env.SENDGRID_API_KEY || "").trim());
  const hasFrom = Boolean((process.env.EMAIL_FROM || "").trim());

  if (provider === "smtp" && !hasSmtp) {
    errors.push("EMAIL_PROVIDER=smtp requires SMTP_URL to be set.");
  }
  if (provider === "resend" && !hasResend) {
    errors.push("EMAIL_PROVIDER=resend requires RESEND_API_KEY to be set.");
  }
  if (provider === "sendgrid" && !hasSendgrid) {
    errors.push("EMAIL_PROVIDER=sendgrid requires SENDGRID_API_KEY to be set.");
  }
  if ((hasSmtp || hasResend || hasSendgrid) && !hasFrom) {
    warnings.push(
      "EMAIL_FROM is not set while an email provider is configured — outgoing mail will use a generic From address.",
    );
  }
  if (isProduction() && requireEmailVerification() && !appOrigin()) {
    errors.push(
      "REQUIRE_EMAIL_VERIFICATION=true requires APP_ORIGIN (public https origin) so verification links can be emailed.",
    );
  }
  if (isProduction() && (hasSmtp || hasResend || hasSendgrid) && !hasFrom) {
    errors.push("EMAIL_FROM is required in production when an email provider is configured.");
  }

  // In production, email verification + password reset need a REAL provider.
  if (isProduction() && requireEmailVerification() && !hasSmtp && !hasResend && !hasSendgrid) {
    errors.push(
      "REQUIRE_EMAIL_VERIFICATION=true requires a real email provider (SMTP_URL, RESEND_API_KEY or SENDGRID_API_KEY).",
    );
  }

  // Production honesty rules (audit fixes):
  // - The mock email adapter is dev/test ONLY; selecting it in production is a
  //   misconfiguration that would silently swallow real email delivery.
  if (isProduction() && provider === "mock") {
    errors.push(
      "EMAIL_PROVIDER=mock is not allowed in production (mock is development/test only).",
    );
  }
  // - A provider selected in production must actually be configured.
  if (isProduction() && provider === "auto" && !hasSmtp && !hasResend && !hasSendgrid) {
    // Not an error: deployments that never send email legitimately run
    // provider-less — every send then fails HONESTLY at runtime (see
    // UnconfiguredEmailProvider). Only warn so operators notice.
    warnings.push(
      "No email provider configured in production — transactional emails (verification, reset) will FAIL until SMTP_URL / RESEND_API_KEY / SENDGRID_API_KEY is set.",
    );
  }
  // - The public origin must be HTTPS in production (cookies are Secure; links
  //   built from a plain-http origin would be wrong).
  const origin = (process.env.APP_ORIGIN || process.env.FRONTEND_URL || "").trim();
  if (isProduction() && origin && !origin.startsWith("https://")) {
    errors.push("APP_ORIGIN must use https:// in production.");
  }
  // - Test-mode overrides must never weaken production (test endpoints,
  //   deterministic dev secrets, mock email outbox).
  if (isProduction() && (process.env.STAYLOOP_TEST === "1" || process.env.NODE_ENV === "test")) {
    errors.push(
      "STAYLOOP_TEST / NODE_ENV=test must not be set in production — test-only behavior would be exposed.",
    );
  }
  // - Rate limits and the OTP/login lockout counters are per-process unless Redis
  //   is configured. Multi-instance production without REDIS_URL silently weakens
  //   every limit by the instance count — make that visible at boot.
  if (isProduction() && !(process.env.REDIS_URL || "").trim()) {
    warnings.push(
      "REDIS_URL is not set in production — rate limits are per-instance (in-process). Set REDIS_URL when running more than one app instance.",
    );
  }
  // - SQLite is a development database only.
  if (isProduction() && (process.env.DATABASE_URL || "").trim().startsWith("file:")) {
    errors.push(
      "DATABASE_URL must be a PostgreSQL connection string in production (file:/SQLite is rejected).",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Combined startup gate — re-exported for instrumentation.ts. */
export function validateAllEnv(): { ok: boolean; errors: string[]; warnings: string[] } {
  const extended = validateExtendedEnv();
  return extended;
}

export { ConfigValidationError, isTest };

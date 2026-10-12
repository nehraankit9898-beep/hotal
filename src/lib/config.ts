import { createHash, randomBytes } from "crypto";
import fs from "fs";
import path from "path";

/**
 * Fail-closed configuration validation (Phase 1 / Phase 4).
 *
 * - Production startup FAILS if AUTH_SECRET / TRACKING_WEBHOOK_SECRET /
 *   INTEGRATION_ENCRYPTION_KEY are missing or weak. No known fallback exists.
 * - Development generates a cryptographically secure secret ONCE and caches it
 *   in `.auth-secret.dev` (gitignored) so sessions survive dev-server restarts.
 *   The generated dev key is never printed or logged.
 * - Secrets are never logged by this module.
 */

export type RuntimeEnv = "development" | "production" | "test";

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * AUDIT FIX (SEC-004): test-only behavior must never activate in production, even
 * if STAYLOOP_TEST leaks into a production environment (startup validation also
 * rejects it; this is the in-code backstop for the mock-email outbox and test hooks).
 */
export function isTest(): boolean {
  if (isProduction()) return false;
  return process.env.NODE_ENV === "test" || process.env.STAYLOOP_TEST === "1";
}

/** Minimum accepted secret length (bytes of entropy-ish characters). */
export const MIN_SECRET_LENGTH = 32;

/** Values that must NEVER be accepted as secrets in any environment. */
const FORBIDDEN_SECRET_VALUES = new Set([
  "stayloop-dev-secret-change-me-in-production",
  "change-me",
  "changeme",
  "secret",
  "test",
  "dev",
  "development",
  "password",
  "phase2-webhook-secret-2026",
  "stayloop_dev_webhook_secret_2026",
]);

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function validateSecret(
  value: string | undefined,
  name: string,
  requiredInProduction: boolean,
): string {
  if (!value || value.trim() === "") {
    if (requiredInProduction && isProduction()) {
      throw new ConfigValidationError(
        `${name} is required in production. Generate one with: openssl rand -hex 32`,
      );
    }
    return "";
  }
  if (
    FORBIDDEN_SECRET_VALUES.has(value.trim()) ||
    FORBIDDEN_SECRET_VALUES.has(value.trim().toLowerCase())
  ) {
    throw new ConfigValidationError(
      `${name} is set to a known placeholder value and is rejected. Generate a real secret with: openssl rand -hex 32`,
    );
  }
  if (value.trim().length < MIN_SECRET_LENGTH) {
    throw new ConfigValidationError(
      `${name} must be at least ${MIN_SECRET_LENGTH} characters long. Generate one with: openssl rand -hex 32`,
    );
  }
  return value.trim();
}

const DEV_SECRET_FILE = ".auth-secret.dev";

/**
 * Development-only secret source. Generates a 64-hex-char random secret on
 * first use and persists it in a gitignored file so it is stable across
 * process restarts. Never used in production.
 */
function getOrCreateDevSecret(purpose: string): string {
  if (process.env.STAYLOOP_TEST === "1") {
    // Deterministic per-purpose secret for tests (tests never rely on secrecy).
    return createHash("sha256").update(`stayloop-test:${purpose}`).digest("hex");
  }

  const filePath = path.join(process.cwd(), DEV_SECRET_FILE);
  try {
    const existing = fs.readFileSync(filePath, "utf8").trim();
    // File holds one line per purpose: "<purpose>=<hex>"
    for (const line of existing.split("\n")) {
      const [k, v] = line.split("=");
      if (k === purpose && v && v.length >= MIN_SECRET_LENGTH) return v;
    }
  } catch {
    // first run — create below
  }
  const generated = randomBytes(32).toString("hex");
  try {
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      /* ignore */
    }
    fs.writeFileSync(filePath, content + `${purpose}=${generated}\n`, { mode: 0o600 });
  } catch {
    // If the filesystem is read-only, fall back to an in-process random secret.
    // Sessions will reset on restart — acceptable for a sandboxed dev box.
  }
  return generated;
}

let cachedAuthSecret: string | null = null;
let cachedWebhookSecret: string | null = null;
let cachedEngineSecret: string | null = null;
let cachedEncryptionKey: Buffer | null = null;
let cachedPreviousEncryptionKeys: { id: string; key: Buffer }[] | null = null;

/** AUTH_SECRET — HMAC signing key for session tokens. Fail-closed in production. */
export function getAuthSecret(): string {
  if (cachedAuthSecret !== null) return cachedAuthSecret;
  const fromEnv = validateSecret(process.env.AUTH_SECRET, "AUTH_SECRET", true);
  cachedAuthSecret =
    fromEnv ||
    (isProduction()
      ? (() => {
          throw new ConfigValidationError(
            "AUTH_SECRET is required in production. Generate one with: openssl rand -hex 32",
          );
        })()
      : getOrCreateDevSecret("auth"));
  return cachedAuthSecret;
}

/** TRACKING_WEBHOOK_SECRET — HMAC key for provider engagement webhooks. */
export function getTrackingWebhookSecret(): string {
  if (cachedWebhookSecret !== null) return cachedWebhookSecret;
  const fromEnv = validateSecret(
    process.env.TRACKING_WEBHOOK_SECRET,
    "TRACKING_WEBHOOK_SECRET",
    true,
  );
  cachedWebhookSecret = fromEnv || (isProduction() ? "" : getOrCreateDevSecret("webhook"));
  if (isProduction() && !cachedWebhookSecret) {
    // Production webhooks stay disabled unless explicitly configured (fail closed:
    // the webhook route returns 503 when the secret is empty).
    return "";
  }
  return cachedWebhookSecret;
}

/** FOLLOWUP_ENGINE_SECRET — cron secret. Optional; if set it must be strong. */
export function getFollowUpEngineSecret(): string {
  if (cachedEngineSecret !== null) return cachedEngineSecret;
  cachedEngineSecret = validateSecret(
    process.env.FOLLOWUP_ENGINE_SECRET,
    "FOLLOWUP_ENGINE_SECRET",
    false,
  );
  return cachedEngineSecret;
}

/**
 * INTEGRATION_ENCRYPTION_KEY — AES-256-GCM key for integration credentials at rest.
 * Production: REQUIRED, 64 hex chars (32 bytes) or 44-char base64.
 * Development/test: derived deterministically from the dev AUTH_SECRET.
 */
export function getIntegrationEncryptionKey(): Buffer {
  if (cachedEncryptionKey) return cachedEncryptionKey;
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!raw || raw.trim() === "") {
    if (isProduction()) {
      throw new ConfigValidationError(
        "INTEGRATION_ENCRYPTION_KEY is required in production. Generate one with: openssl rand -hex 32",
      );
    }
    cachedEncryptionKey = createHash("sha256")
      .update(`stayloop-integrations:${getOrCreateDevSecret("integration-key")}`)
      .digest();
    return cachedEncryptionKey;
  }
  const trimmed = raw.trim();
  const asHex = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : null;
  const asB64 = /^[A-Za-z0-9+/]{43}=$/.test(trimmed) ? Buffer.from(trimmed, "base64") : null;
  const key = asHex ?? asB64;
  if (!key || key.length !== 32) {
    throw new ConfigValidationError(
      "INTEGRATION_ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars or 44-char base64). Generate one with: openssl rand -hex 32",
    );
  }
  cachedEncryptionKey = key;
  return cachedEncryptionKey;
}

/**
 * INTEGRATION_ENCRYPTION_PREVIOUS_KEYS — retired keys kept decryptable
 * during/after rotation. Comma-separated "<id>:<64-hex>" entries:
 *   INTEGRATION_ENCRYPTION_PREVIOUS_KEYS=old2026:0123abcd...64hex...,...
 * Malformed entries are SKIPPED (never throw at decrypt time); an empty or
 * unset variable yields an empty list. Used for backup archives, integration
 * credentials AND platform billing secrets (audit fix: the variable was
 * documented but only implemented for archives — stored credentials became
 * undecryptable after a key rotation).
 */
export function getPreviousIntegrationEncryptionKeys(): { id: string; key: Buffer }[] {
  if (cachedPreviousEncryptionKeys !== null) return cachedPreviousEncryptionKeys;
  const parsed: { id: string; key: Buffer }[] = [];
  const raw = (process.env.INTEGRATION_ENCRYPTION_PREVIOUS_KEYS ?? "").trim();
  if (raw) {
    for (const entry of raw.split(",")) {
      const idx = entry.indexOf(":");
      if (idx <= 0) continue;
      const id = entry.slice(0, idx).trim();
      const hex = entry.slice(idx + 1).trim();
      if (!id || !/^[0-9a-fA-F]{64}$/.test(hex)) continue;
      parsed.push({ id, key: Buffer.from(hex, "hex") });
    }
  }
  cachedPreviousEncryptionKeys = parsed;
  return parsed;
}

/**
 * The full decryption keyring: CURRENT key first, then the declared previous
 * keys (rotation fallback). Same ordering contract as
 * src/lib/saas/backup.ts so every ciphertext type tries keys in the same
 * order.
 */
export function getIntegrationEncryptionKeyring(): { id: string; key: Buffer }[] {
  return [
    { id: "default", key: getIntegrationEncryptionKey() },
    ...getPreviousIntegrationEncryptionKeys(),
  ];
}

/**
 * ADMIN_BOOTSTRAP_SECRET — one-time bootstrap authorization for creating the
 * first Super Admin (Phase 2). Optional; if unset, bootstrap is disabled.
 * When set it must not be a known-weak value.
 */
export function getAdminBootstrapSecret(): string {
  const raw = process.env.ADMIN_BOOTSTRAP_SECRET;
  if (!raw || raw.trim() === "") return "";
  if (isProduction() && raw.trim().length < MIN_SECRET_LENGTH) {
    throw new ConfigValidationError(
      `ADMIN_BOOTSTRAP_SECRET must be at least ${MIN_SECRET_LENGTH} characters long in production.`,
    );
  }
  return raw.trim();
}

/**
 * TEST-ONLY cache reset (guards: STAYLOOP_TEST=1 / NODE_ENV=test). Used by
 * the ops-reliability suite to simulate encryption-key ROTATION within one
 * process: getIntegrationEncryptionKey() caches the first key it resolved,
 * so without this hook the test could not observe rotation behavior.
 */
export function __resetEncryptionKeyCacheForTests(): void {
  if (process.env.NODE_ENV !== "test" && process.env.STAYLOOP_TEST !== "1") {
    throw new Error("Test-only helper called outside a test environment.");
  }
  cachedEncryptionKey = null;
  cachedPreviousEncryptionKeys = null;
}

/**
 * Validate all configuration at startup. Called from instrumentation.ts
 * (Next.js) — a misconfigured production deployment refuses to boot instead
 * of silently running with a known fallback secret.
 */
export function validateStartupConfig(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  try {
    getAuthSecret();
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  if (isProduction()) {
    try {
      getIntegrationEncryptionKey();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    // TRACKING_WEBHOOK_SECRET is optional in production (webhook disabled if
    // unset) but if present it must be strong.
    try {
      validateSecret(process.env.TRACKING_WEBHOOK_SECRET, "TRACKING_WEBHOOK_SECRET", false);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { ok: errors.length === 0, errors };
}

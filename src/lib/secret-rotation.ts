/**
 * Phase 17 — Secret rotation audit.
 *
 * End-to-end secret rotation including MFA recovery, key strategy, encrypted
 * credentials/backups and expired tokens. Captures the before/after state
 * without storing the secret material.
 *
 * This module ONLY records the audit trail. The actual rotation of secrets
 * is performed out-of-band (operator action). The audit row exists so:
 *  - operators can verify rotation cadence
 *  - compliance can evidence key rotation occurred
 *  - incident responders can see the last-known-rotation timestamp
 *
 * The beforeHash/afterHash fields are sha256 hex strings — never the
 * secret material itself. The hashes are NOT used for any authentication
 * purpose; they only allow verifying that the secret actually changed.
 */
import { createHash } from "crypto";
import { db } from "@/lib/db";

export type SecretKey =
  | "AUTH_SECRET"
  | "INTEGRATION_ENCRYPTION_KEY"
  | "INTEGRATION_ENCRYPTION_PREVIOUS_KEYS"
  | "TRACKING_WEBHOOK_SECRET"
  | "FOLLOWUP_ENGINE_SECRET"
  | "ADMIN_BOOTSTRAP_SECRET"
  | "MFA_RECOVERY_CODES";

export type RotationReason = "SCHEDULED" | "COMPROMISE" | "KEY_EXPIRY" | "MANUAL";

/**
 * Compute the sha256 hash of a secret value, for audit purposes only.
 * Returns a hex string. Never store the actual secret.
 */
export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Record a secret rotation event. The caller MUST pass the OLD secret value
 * and the NEW secret value; this function computes their hashes and stores
 * ONLY the hashes. The secret material is never persisted.
 *
 * The caller is responsible for ensuring the new secret is actually deployed
 * (env vars, integration credentials, etc.) BEFORE calling this function.
 */
export async function recordSecretRotation(input: {
  secretKey: SecretKey | string;
  reason: RotationReason;
  performedBy?: string;
  oldValue: string;
  newValue: string;
  notes?: string;
}): Promise<{ id: string; changed: boolean }> {
  const beforeHash = hashSecret(input.oldValue);
  const afterHash = hashSecret(input.newValue);
  const changed = beforeHash !== afterHash;
  const created = await db.secretRotation.create({
    data: {
      secretKey: input.secretKey,
      reason: input.reason,
      performedBy: input.performedBy ?? null,
      beforeHash,
      afterHash,
      notes: input.notes?.slice(0, 500) ?? null,
    },
    select: { id: true },
  });
  return { id: created.id, changed };
}

/**
 * Get the last rotation timestamp for a secret key. Used by the operator
 * dashboard to surface "rotation overdue" warnings.
 */
export async function getLastRotation(secretKey: string): Promise<Date | null> {
  const last = await db.secretRotation.findFirst({
    where: { secretKey },
    orderBy: { rotatedAt: "desc" },
    select: { rotatedAt: true },
  });
  return last?.rotatedAt ?? null;
}

/**
 * List recent secret rotations across all keys. Used by the security
 * operations dashboard.
 */
export async function listRecentRotations(limit = 50) {
  return db.secretRotation.findMany({
    orderBy: { rotatedAt: "desc" },
    take: limit,
    select: {
      id: true,
      secretKey: true,
      reason: true,
      performedBy: true,
      rotatedAt: true,
      notes: true,
    },
  });
}

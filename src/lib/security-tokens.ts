/**
 * Phase 7 — cryptographically secure, hashed, one-time, expiring tokens.
 *
 * Used by: email verification (EMAIL_VERIFICATION) and password reset
 * (PASSWORD_RESET). Only the SHA-256 hash of a token is ever stored; the raw
 * token exists solely inside the emailed link.
 *
 * Properties (per Phase 7 spec §6/§7):
 * - 32 random bytes (256 bits) of entropy, URL-safe base64url
 * - hashed storage (a DB leak does not leak usable tokens)
 * - expiration (per-purpose TTL)
 * - one-time use (consumed atomically, token row deleted)
 * - old tokens invalidated when a new one is issued for the same user/purpose
 */

import { createHash, randomBytes } from "crypto";
import { db } from "@/lib/db";

export type SecurityTokenPurpose = "EMAIL_VERIFICATION" | "PASSWORD_RESET";

export const TOKEN_TTL_MINUTES: Record<SecurityTokenPurpose, number> = {
  EMAIL_VERIFICATION: 24 * 60, // 24 hours
  PASSWORD_RESET: 60, // 1 hour
};

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Issue a new token for a user+purpose. Atomically invalidates any previous
 * unconsumed tokens for the same user+purpose. Returns the RAW token (to be
 * embedded in a link exactly once).
 */
export async function issueSecurityToken(
  userId: string,
  purpose: SecurityTokenPurpose,
): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES[purpose] * 60 * 1000);

  await db.$transaction([
    // Invalidate previous tokens for this user+purpose (one active token at a time).
    db.activationToken.deleteMany({ where: { userId, purpose } }),
    db.activationToken.create({
      data: { userId, tokenHash, purpose, expiresAt },
    }),
  ]);

  return raw;
}

export type ConsumeResult =
  { ok: true; userId: string } | { ok: false; reason: "invalid" | "expired" };

/**
 * Consume a token: validates hash + expiry, then deletes the row atomically
 * (one-time use). Expired tokens are deleted and reported as expired.
 */
export async function consumeSecurityToken(
  raw: string,
  purpose: SecurityTokenPurpose,
): Promise<ConsumeResult> {
  if (!raw || raw.length < 20 || raw.length > 128) return { ok: false, reason: "invalid" };
  const tokenHash = hashToken(raw);

  const record = await db.activationToken.findUnique({ where: { tokenHash } });
  if (!record || record.purpose !== purpose || record.usedAt) {
    return { ok: false, reason: "invalid" };
  }

  // Atomic one-time consumption: delete only if it still exists.
  const deleted = await db.activationToken.deleteMany({
    where: { tokenHash, usedAt: null },
  });
  if (deleted.count === 0) return { ok: false, reason: "invalid" };

  if (record.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, userId: record.userId };
}

/** Remove all expired tokens (housekeeping — safe to call periodically). */
export async function purgeExpiredTokens(): Promise<number> {
  const res = await db.activationToken.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return res.count;
}

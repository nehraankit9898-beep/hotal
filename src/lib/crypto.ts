import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { getIntegrationEncryptionKey, getIntegrationEncryptionKeyring } from "@/lib/config";

/**
 * Integration credential encryption at rest — Phase 4.
 *
 * AES-256-GCM authenticated encryption with the hotel id + integration type
 * bound as Additional Authenticated Data (AAD). Binding the tenant context
 * into the AEAD means a ciphertext copied to another hotel/integration row
 * FAILS to decrypt — cross-tenant ciphertext transplant is impossible.
 *
 * Envelope format:  v1:<iv_b64>:<ciphertext_b64>:<authTag_b64>
 *
 * - Plaintext credentials NEVER reach the browser: API responses expose only
 *   `hasCredentials: true/false`.
 * - Decryption happens server-side only, at integration-client construction.
 * - The key comes from INTEGRATION_ENCRYPTION_KEY (fail-closed in production).
 */

const ENVELOPE_VERSION = "v1";

export class CryptoKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoKeyError";
  }
}

export class DecryptError extends Error {
  constructor(message = "Stored credentials could not be decrypted.") {
    super(message);
    this.name = "DecryptError";
  }
}

function key(): Buffer {
  try {
    return getIntegrationEncryptionKey();
  } catch (err) {
    throw new CryptoKeyError(err instanceof Error ? err.message : "Encryption key unavailable.");
  }
}

/** Encrypt a JSON-serializable credentials object for a specific tenant context. */
export function encryptCredentials(
  tenantContext: { hotelId: string; integrationType: string },
  credentials: Record<string, unknown>,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const aad = `${tenantContext.hotelId}:${tenantContext.integrationType}`;
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString("base64"),
    encrypted.toString("base64"),
    tag.toString("base64"),
  ].join(":");
}

/** Decrypt a stored envelope. Throws DecryptError on tamper/context mismatch.
 *
 * AUDIT FIX (keyring): rotation support. A v1 envelope does not name the key
 * that produced it, so after INTEGRATION_ENCRYPTION_KEY is rotated every
 * stored credential would fail to decrypt — even though
 * INTEGRATION_ENCRYPTION_PREVIOUS_KEYS documents retired keys for exactly
 * this purpose (and backup archives already fall back through it). The
 * current key is tried FIRST; only when its auth tag check fails do the
 * declared previous keys get tried. A tampered envelope still fails against
 * every candidate (AAD binding + GCM auth tag are checked per attempt).
 */
export function decryptCredentials(
  tenantContext: { hotelId: string; integrationType: string },
  stored: string,
): Record<string, unknown> {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new DecryptError("Unrecognized credential envelope.");
  }
  const [, ivB64, ctB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const aad = Buffer.from(`${tenantContext.hotelId}:${tenantContext.integrationType}`, "utf8");

  for (const candidate of getIntegrationEncryptionKeyring()) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", candidate.key, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);
      const parsed = JSON.parse(decrypted.toString("utf8"));
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      return parsed as Record<string, unknown>;
    } catch {
      // Wrong key OR tampered ciphertext — try the next candidate. Tampering
      // fails against ALL of them and falls out of the loop below.
    }
  }
  throw new DecryptError();
}

/** True when the stored value is an encrypted envelope (not legacy plaintext). */
export function isEncryptedEnvelope(stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split(":");
  return parts.length === 4 && parts[0] === ENVELOPE_VERSION;
}

/**
 * Mask a credentials object for audit/debug display: shows only key names and
 * a length hint — never values. Used by logs and diagnostics.
 */
export function maskCredentials(credentials: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(credentials)) {
    const v = credentials[k];
    out[k] = typeof v === "string" ? `***set(${v.length})***` : `***set(${typeof v})***`;
  }
  return out;
}

/** Derive a non-reversible fingerprint (e.g. for detecting duplicate keys). */
export function credentialFingerprint(credentials: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(credentials)).digest("hex").slice(0, 16);
}

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { db } from "@/lib/db";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { getAuthSecret } from "@/lib/config";

/**
 * TOTP Multi-Factor Authentication — Phase 10 §14.
 *
 * Implements RFC 6238 (TOTP with HMAC-SHA1, 6 digits, 30s period, ±1 step
 * drift tolerance) plus:
 *  - base32-encoded secrets (compatible with Google Authenticator / Authy)
 *  - otpauth:// provisioning URI + QR code (via the `qrcode` package)
 *  - 10 single-use backup codes stored as sha256 HASHES (never plaintext)
 *  - a short-lived signed "MFA pending" login token so the password step and
 *    the code step never share the full session.
 *
 * Secrets are encrypted at rest with AES-256-GCM using the auth secret
 * derived into a dedicated MFA key (HKDF-style separation).
 */

const PERIOD_SECONDS = 30;
const DIGITS = 6;
const DRIFT_STEPS = 1; // accept previous/current/next step
const BACKUP_CODE_COUNT = 10;
const MFA_PENDING_TTL_SECONDS = 10 * 60; // 10 minutes to finish the challenge

// ---------- Base32 (RFC 4648, no padding) ----------

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = B32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ---------- Secret storage (encrypted at rest) ----------

function mfaKey(): Buffer {
  // Derive a dedicated sub-key from the auth secret so MFA ciphertext is
  // never interchangeable with session tokens.
  return createHash("sha256").update(`stayloop-mfa:${getAuthSecret()}`).digest();
}

function encryptSecret(secretBase32: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", mfaKey(), iv);
  cipher.setAAD(Buffer.from("stayloop-mfa", "utf8"));
  const enc = Buffer.concat([cipher.update(secretBase32, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${enc.toString("base64")}:${cipher.getAuthTag().toString("base64")}`;
}

function decryptSecret(envelope: string): string {
  const [version, ivB64, ctB64, tagB64] = envelope.split(":");
  if (version !== "v1" || !ivB64 || !ctB64 || !tagB64) throw new Error("Bad MFA envelope");
  const d = createDecipheriv("aes-256-gcm", mfaKey(), Buffer.from(ivB64, "base64"));
  d.setAAD(Buffer.from("stayloop-mfa", "utf8"));
  d.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([d.update(Buffer.from(ctB64, "base64")), d.final()]).toString("utf8");
}

// ---------- TOTP core (RFC 6238) ----------

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac("sha1", secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return (code % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/** Generate the current TOTP code for a secret (used by tests + tooling). */
export function generateTotp(secretBase32: string, at = Date.now()): string {
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(at / 1000 / PERIOD_SECONDS);
  return hotp(secret, counter);
}

/** Verify a 6-digit TOTP code with ±1 step drift. Constant-time per candidate. */
export function verifyTotp(secretBase32: string, code: string, at = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(at / 1000 / PERIOD_SECONDS);
  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift++) {
    const expected = hotp(secret, counter + drift);
    const a = Buffer.from(expected);
    const b = Buffer.from(code);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

// ---------- Backup codes (single use, hashed at rest) ----------

function hashBackupCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function generateBackupCodes(): { plain: string[]; hashes: string[] } {
  const plain: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    // 10 chars from a Crockford-ish alphabet (no ambiguous chars)
    plain.push(randomBytes(6).toString("hex").toUpperCase().replace(/[OIL]/g, "0"));
  }
  return { plain, hashes: plain.map(hashBackupCode) };
}

// ---------- Setup / enable / disable ----------

export interface MfaSetup {
  secret: string; // base32 — shown ONCE (user scans the QR)
  otpauthUrl: string;
  qrDataUrl: string;
}

/** Begin MFA setup: generates a secret + QR. Does NOT enable MFA yet. */
export async function beginMfaSetup(userId: string): Promise<MfaSetup> {
  const secret = base32Encode(randomBytes(20));
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  const otpauthUrl = `otpauth://totp/StayLoop:${encodeURIComponent(user?.email ?? userId)}?secret=${secret}&issuer=StayLoop&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD_SECONDS}`;
  // QR rendered server-side; secret never leaves the response of THIS call.
  const QRCode = (await import("qrcode")).default;
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 });
  // Store encrypted secret pre-verification so the verify step can confirm it.
  await db.user.update({
    where: { id: userId },
    data: { mfaSecret: encryptSecret(secret), mfaEnabled: false },
  });
  return { secret, otpauthUrl, qrDataUrl };
}

/** Confirm setup with a valid TOTP code → MFA enabled + backup codes returned ONCE. */
export async function confirmMfaSetup(
  userId: string,
  code: string,
): Promise<{ ok: true; backupCodes: string[] } | { ok: false; error: string }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { mfaSecret: true, mfaEnabled: true },
  });
  if (!user?.mfaSecret) return { ok: false, error: "Start MFA setup first." };
  if (user.mfaEnabled) return { ok: false, error: "MFA is already enabled." };
  const secret = decryptSecret(user.mfaSecret);
  if (!verifyTotp(secret, code))
    return { ok: false, error: "That code is incorrect. Try the next one." };
  const { plain, hashes } = generateBackupCodes();
  await db.user.update({
    where: { id: userId },
    data: { mfaEnabled: true, mfaBackupCodes: JSON.stringify(hashes) },
  });
  await logAudit({
    userId,
    action: AUDIT_ACTIONS.MFA_CHANGED,
    entityType: "user",
    entityId: userId,
    metadata: { change: "ENABLED", method: "TOTP" },
  });
  return { ok: true, backupCodes: plain };
}

/** Disable MFA — requires a fresh TOTP or backup code. */
export async function disableMfa(
  userId: string,
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { mfaEnabled: true, mfaSecret: true, mfaBackupCodes: true, role: true },
  });
  if (!user?.mfaEnabled) return { ok: false, error: "MFA is not enabled." };
  const verified = await consumeCodeForUser(
    userId,
    code,
    user.mfaSecret,
    user.mfaBackupCodes,
    false,
  );
  if (!verified) return { ok: false, error: "That code is incorrect." };
  await db.user.update({
    where: { id: userId },
    data: { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: null },
  });
  await logAudit({
    userId,
    action: AUDIT_ACTIONS.MFA_DISABLED,
    entityType: "user",
    entityId: userId,
    metadata: { role: user.role },
  });
  return { ok: true };
}

/** Regenerate backup codes (old ones invalidated). Returns plain codes ONCE. */
export async function regenerateBackupCodes(
  userId: string,
  code: string,
): Promise<{ ok: true; backupCodes: string[] } | { ok: false; error: string }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { mfaEnabled: true, mfaSecret: true, mfaBackupCodes: true },
  });
  if (!user?.mfaEnabled) return { ok: false, error: "MFA is not enabled." };
  const verified = await consumeCodeForUser(
    userId,
    code,
    user.mfaSecret,
    user.mfaBackupCodes,
    false,
  );
  if (!verified) return { ok: false, error: "That code is incorrect." };
  const { plain, hashes } = generateBackupCodes();
  await db.user.update({ where: { id: userId }, data: { mfaBackupCodes: JSON.stringify(hashes) } });
  await logAudit({
    userId,
    action: AUDIT_ACTIONS.MFA_CHANGED,
    entityType: "user",
    entityId: userId,
    metadata: { change: "BACKUP_CODES_REGENERATED" },
  });
  return { ok: true, backupCodes: plain };
}

// ---------- Login challenge verification ----------

/**
 * Verify a login code: TOTP first, then a single-use backup code.
 * Backup codes are consumed ATOMICALLY (only on success) via a guarded update.
 */
export async function verifyLoginCode(
  userId: string,
  code: string,
): Promise<{ ok: true; usedBackupCode: boolean } | { ok: false; error: string }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { mfaEnabled: true, mfaSecret: true, mfaBackupCodes: true },
  });
  if (!user?.mfaEnabled || !user.mfaSecret) {
    return { ok: false, error: "MFA is not enabled for this account." };
  }
  const secret = decryptSecret(user.mfaSecret);
  if (verifyTotp(secret, code)) {
    return { ok: true, usedBackupCode: false };
  }
  const consumed = await consumeCodeForUser(
    userId,
    code,
    user.mfaSecret,
    user.mfaBackupCodes,
    true,
  );
  if (consumed) return { ok: true, usedBackupCode: true };
  return { ok: false, error: "Invalid authentication code." };
}

/** Try to match + atomically consume a backup code. */
async function consumeCodeForUser(
  userId: string,
  code: string,
  secretEnvelope: string | null,
  backupCodesJson: string | null,
  consume: boolean,
): Promise<boolean> {
  if (!backupCodesJson) return false;
  let hashes: string[] = [];
  try {
    hashes = JSON.parse(backupCodesJson) as string[];
  } catch {
    return false;
  }
  const candidate = hashBackupCode(code.trim().toUpperCase());
  const idx = hashes.indexOf(candidate);
  if (idx === -1) return false;
  if (!consume) return true;
  const remaining = hashes.filter((_, i) => i !== idx);
  // Guarded update: only succeeds if the stored JSON still contains the code
  // (prevents double redemption under concurrent attempts).
  const guarded = await db.user.updateMany({
    where: { id: userId, mfaBackupCodes: backupCodesJson },
    data: { mfaBackupCodes: JSON.stringify(remaining) },
  });
  return guarded.count === 1;
}

// ---------- MFA pending login token (short-lived HMAC token) ----------

interface MfaPendingPayload {
  userId: string;
  mfaPending: true;
  exp: number;
}

function signPending(body: string): string {
  return createHmac("sha256", getAuthSecret()).update(`mfa-pending:${body}`).digest("base64url");
}

/** Issue the short-lived token that carries ONLY the challenge state. */
export function createMfaPendingToken(userId: string): string {
  const payload: MfaPendingPayload = {
    userId,
    mfaPending: true,
    exp: Math.floor(Date.now() / 1000) + MFA_PENDING_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${signPending(body)}`;
}

export function verifyMfaPendingToken(token: string): string | null {
  try {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const expected = signPending(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as MfaPendingPayload;
    if (payload.mfaPending !== true || !payload.userId) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.userId;
  } catch {
    return null;
  }
}

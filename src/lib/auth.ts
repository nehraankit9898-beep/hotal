import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  scryptSync,
  timingSafeEqual,
  type ScryptOptions,
} from "crypto";
import { getAuthSecret } from "@/lib/config";
import { isSecureRequest } from "@/lib/proxy";

/**
 * Authentication core: password hashing (scrypt) + HMAC-signed session tokens.
 * No plaintext passwords, no secrets in code (AUTH_SECRET from env — Phase 1:
 * fail-closed, no fallback), session revocation via per-user token version
 * (Phase 9).
 */

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// ---------- Password hashing (scrypt: memory-hard KDF) ----------
//
// Current format (v2):  scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
//   N=2^17, r=8, p=1 — the OWASP-recommended scrypt baseline.
// Legacy format (v1):   scrypt$<saltHex>$<hashHex>  (N=16384, r=8, p=1)
//
// SECURITY FIX: the old fixed N=16384 is below the current recommendation.
// Legacy hashes still verify and are transparently re-hashed to v2 on the
// next successful login (see needsRehash + the login route).

const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const LEGACY_N = 16384;
const LEGACY_R = 8;
const LEGACY_P = 1;

/** Node's default maxmem (32 MiB) is too small for N=2^17; size it explicitly. */
function scryptOptions(N: number, r: number, p: number) {
  return { N, r, p, maxmem: 2 * 128 * N * r };
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(
    password,
    salt,
    SCRYPT_KEYLEN,
    scryptOptions(SCRYPT_N, SCRYPT_R, SCRYPT_P),
  ).toString("hex");
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

/**
 * Async scrypt: runs on the libuv thread pool instead of blocking the event loop
 * (a v2 hash costs ~0.4 s of CPU). Request handlers should prefer these.
 */
function scryptAsync(
  password: string,
  salt: string,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (
    await scryptAsync(password, salt, SCRYPT_KEYLEN, scryptOptions(SCRYPT_N, SCRYPT_R, SCRYPT_P))
  ).toString("hex");
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

function parseStoredHash(
  stored: string,
): { N: number; r: number; p: number; salt: string; hash: string } | null {
  const parts = stored.split("$");
  if (parts[0] !== "scrypt") return null;
  if (parts.length === 3) {
    const [, salt, hash] = parts;
    return salt && hash ? { N: LEGACY_N, r: LEGACY_R, p: LEGACY_P, salt, hash } : null;
  }
  if (parts.length === 6) {
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const [, , , , salt, hash] = parts;
    if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0 || N > 2 ** 20) return null;
    if (!Number.isInteger(r) || r < 1 || r > 32) return null;
    if (!Number.isInteger(p) || p < 1 || p > 8) return null;
    return salt && hash ? { N, r, p, salt, hash } : null;
  }
  return null;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parsed = parseStoredHash(stored);
    if (!parsed) return false;
    const expected = Buffer.from(parsed.hash, "hex");
    const candidate = scryptSync(
      password,
      parsed.salt,
      expected.length,
      scryptOptions(parsed.N, parsed.r, parsed.p),
    );
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

/** Non-blocking variant of verifyPassword (same result, same parsing rules). */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  try {
    const parsed = parseStoredHash(stored);
    if (!parsed) return false;
    const expected = Buffer.from(parsed.hash, "hex");
    const candidate = await scryptAsync(
      password,
      parsed.salt,
      expected.length,
      scryptOptions(parsed.N, parsed.r, parsed.p),
    );
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash uses legacy parameters and should be re-hashed. */
export function needsRehash(stored: string): boolean {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  return parsed.N !== SCRYPT_N || parsed.r !== SCRYPT_R || parsed.p !== SCRYPT_P;
}

let dummyHash: string | null = null;
/**
 * A real hash used to keep login timing constant when the email is unknown.
 * Verifying against it costs the same scrypt work as a real account.
 */
export function dummyPasswordHash(): string {
  if (!dummyHash) dummyHash = hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

// ---------- Session token (compact JWT-like: base64url(payload).base64url(hmac)) ----------

export type UserRole =
  | "HOTEL_ADMIN"
  | "HOTEL_STAFF"
  | "SUPER_ADMIN"
  | "HOTEL_OWNER"
  | "HOTEL_MANAGER"
  | "MARKETING_MANAGER"
  | "RESTAURANT_MANAGER"
  | "FRONT_DESK"
  // Phase 13 — restaurant staff roles
  | "CASHIER"
  | "KITCHEN_STAFF"
  | "WAITER";

export interface SessionPayload {
  userId: string;
  hotelId: string; // empty for SUPER_ADMIN
  role: UserRole;
  exp: number; // epoch seconds
  vtv?: number; // token version — must match User.tokenVersion (revocation)
  mcp?: boolean; // mustChangePassword — restricted session when true
  // Phase 10 — MFA policy: role requires MFA but user has not enrolled yet.
  // The session is restricted to MFA enrolment + self-service routes until
  // MFA is enabled (enforced in requireAuth, mirrored server-side).
  msr?: boolean; // mfaSetupRequired
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string): string {
  return createHmac("sha256", getAuthSecret()).update(data).digest("base64url");
}

export function createSessionToken(
  payload: Omit<SessionPayload, "exp"> & { vtv?: number; mcp?: boolean; msr?: boolean },
): string {
  const full: SessionPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const body = b64url(JSON.stringify(full));
  return `${body}.${sign(body)}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
  try {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const expected = sign(body);
    // constant-time compare
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (!payload.userId || payload.exp === undefined) return null;
    // SUPER_ADMIN is allowed to have empty hotelId; everyone else needs a hotelId
    if (payload.role !== "SUPER_ADMIN" && !payload.hotelId) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- Cookie handling ----------

export const SESSION_COOKIE = "stayloop_session";
export const CSRF_COOKIE = "stayloop_csrf";

/**
 * Cookie options that work in BOTH contexts:
 * - Direct top-level browsing (same-site): SameSite=Lax is fine.
 * - Cross-site iframe embedding (preview panel): browsers block Lax
 *   cookies entirely, which caused "login succeeds but session is lost".
 *   Over HTTPS we therefore use SameSite=None; Secure; Partitioned (CHIPS)
 *   so the session cookie is stored inside the embedded context.
 * - Plain HTTP (local dev): Secure cookies are not stored, so we fall
 *   back to SameSite=Lax without the Secure flag.
 */
export function sessionCookieOptions(req?: Request) {
  const secure = isSecureRequest(req);
  return {
    httpOnly: true as const,
    sameSite: (secure ? "none" : "lax") as "none" | "lax",
    secure,
    partitioned: secure,
    path: "/",
    maxAge: TOKEN_TTL_SECONDS,
  };
}

/** Options used to CLEAR the session cookie (must mirror set-attributes). */
export function clearSessionCookieOptions(req?: Request) {
  return { ...sessionCookieOptions(req), maxAge: 0 };
}

export type SessionSource = "cookie" | "bearer";

/**
 * SECURITY/ROBUSTNESS FIX: decodeURIComponent throws URIError on malformed
 * percent-encoding. A bad cookie must mean "not authenticated" (401), never an
 * unhandled 500.
 */
export function safeDecodeCookie(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Extract session + HOW it was presented (cookie or bearer). */
export function getSessionAuth(
  req: Request,
): { session: SessionPayload; via: SessionSource } | null {
  const cookieHeader = req.headers.get("cookie");
  if (cookieHeader) {
    for (const part of cookieHeader.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      const key = part.slice(0, idx).trim();
      if (key === SESSION_COOKIE) {
        const value = safeDecodeCookie(part.slice(idx + 1).trim());
        const payload = value ? verifySessionToken(value) : null;
        if (payload) return { session: payload, via: "cookie" };
      }
    }
  }
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const payload = verifySessionToken(authHeader.slice(7).trim());
    if (payload) return { session: payload, via: "bearer" };
  }
  return null;
}

/** Extract session from a Request: cookie first, then Authorization: Bearer fallback. */
export function getSession(req: Request): SessionPayload | null {
  return getSessionAuth(req)?.session ?? null;
}

/** Basic password strength validation. */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters long.";
  if (password.length > 128) return "Password must be at most 128 characters long.";
  if (!/[a-zA-Z]/.test(password)) return "Password must contain at least one letter.";
  if (!/[0-9]/.test(password)) return "Password must contain at least one number.";
  return null;
}

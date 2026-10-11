import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
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

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, salt, hash] = stored.split("$");
    if (scheme !== "scrypt" || !salt || !hash) return false;
    const candidate = scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
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
        const value = decodeURIComponent(part.slice(idx + 1).trim());
        const payload = verifySessionToken(value);
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

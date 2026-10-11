/**
 * Phase 11 — Developer API keys.
 *
 * Design:
 *  - Keys look like `sk_live_<32 hex chars>` and are shown to the user EXACTLY
 *    once at creation. Only a sha256 hash is persisted, so a DB leak does not
 *    leak usable credentials.
 *  - Authentication for /api/v1/* accepts either
 *      Authorization: Bearer sk_live_…     (recommended)
 *      X-API-Key: sk_live_…                (alternative)
 *  - Every authenticated request bumps `requests` + `lastUsedAt` (fire-and-forget,
 *    never blocks the response) and meters into the plan's apiRequests usage.
 *  - Key creation is gated by the hotel's plan (`Plan.apiAccess`).
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { incrementUsage } from "@/lib/saas/limits";

export const API_KEY_PREFIX = "sk_live_";

export type ApiKeyScopes = "read" | "write";

export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(16).toString("hex");
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function displayPrefix(key: string): string {
  return key.slice(0, API_KEY_PREFIX.length + 6) + "…";
}

export function parseScopes(raw: string): ApiKeyScopes[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => s === "read" || s === "write") : ["read"];
  } catch {
    return ["read"];
  }
}

export interface ApiKeyAuth {
  keyId: string;
  hotelId: string;
  hotelName: string;
  hotelStatus: string;
  scopes: ApiKeyScopes[];
}

function extractKey(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith(API_KEY_PREFIX)) return token;
  }
  const xApiKey = req.headers.get("x-api-key");
  if (xApiKey?.startsWith(API_KEY_PREFIX)) return xApiKey.trim();
  return null;
}

/**
 * Authenticate a /api/v1/* request via API key. Returns a structured error
 * (never a Response — the route layer decides the JSON shape).
 *
 * AUDIT FIX (F15): the old check only rejected SUSPENDED hotels — a key whose
 * hotel was ARCHIVED, whose plan had apiAccess disabled, or whose subscription
 * had EXPIRED still authenticated (the creation-time entitlement check does
 * not cover pre-existing/downgraded keys). Authentication now re-validates
 * the FULL commercial/account state on EVERY request:
 *   - hotel must be ACTIVE (not merely not-suspended)
 *   - the hotel's plan must include API access (plan.apiAccess)
 *   - the subscription must be ACTIVE/TRIALING/GRACE (not EXPIRED/CANCELLED)
 * Keys are additionally bound to those states at request time, so revoking a
 * plan or archiving a tenant takes effect immediately without waiting for a
 * key rotation.
 */
export async function authenticateApiKey(
  req: Request,
): Promise<
  { ok: true; auth: ApiKeyAuth } | { ok: false; status: number; code: string; message: string }
> {
  const key = extractKey(req);
  if (!key) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      message:
        "Missing API key. Send it as 'Authorization: Bearer sk_live_…' or 'X-API-Key: sk_live_…'.",
    };
  }

  const hash = hashApiKey(key);
  const record = await db.apiKey.findUnique({
    where: { keyHash: hash },
    include: { hotel: { select: { id: true, name: true, status: true } } },
  });
  if (!record) {
    return {
      ok: false,
      status: 401,
      code: "INVALID_KEY",
      message: "This API key does not exist or was deleted.",
    };
  }
  if (record.status !== "ACTIVE" || record.revokedAt) {
    return {
      ok: false,
      status: 401,
      code: "KEY_REVOKED",
      message: "This API key has been revoked. Create a new one.",
    };
  }
  // F15: full account state — ACTIVE required (ARCHIVED/INACTIVE tenants are
  // locked out too, not only SUSPENDED ones).
  if (record.hotel.status !== "ACTIVE") {
    return {
      ok: false,
      status: 403,
      code: "HOTEL_NOT_ACTIVE",
      message: `This hotel account is ${record.hotel.status.toLowerCase()} — API access is disabled.`,
    };
  }

  // F15: plan-level API entitlement must STILL hold for existing keys.
  const hotel = await db.hotel.findUnique({
    where: { id: record.hotelId },
    select: { plan: { select: { apiAccess: true, key: true } } },
  });
  if (!hotel) {
    return {
      ok: false,
      status: 403,
      code: "HOTEL_NOT_FOUND",
      message: "This hotel account no longer exists.",
    };
  }
  if (hotel.plan && hotel.plan.apiAccess !== true) {
    return {
      ok: false,
      status: 403,
      code: "PLAN_API_DISABLED",
      message: "The hotel's current plan does not include developer API access.",
    };
  }

  // F15: subscription must be commercially active (EXPIRED/CANCELLED keys die).
  const subscription = await db.subscription.findFirst({
    where: { hotelId: record.hotelId },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  });
  if (subscription && !["ACTIVE", "TRIALING", "GRACE"].includes(subscription.status)) {
    return {
      ok: false,
      status: 403,
      code: "SUBSCRIPTION_INACTIVE",
      message: `The hotel's subscription is ${subscription.status.toLowerCase()} — API access is suspended.`,
    };
  }

  // Usage metering — fire-and-forget so it never slows the response.
  const hotelId = record.hotelId;
  const keyId = record.id;
  void db.apiKey
    .update({ where: { id: keyId }, data: { requests: { increment: 1 }, lastUsedAt: new Date() } })
    .catch(() => undefined);
  void incrementUsage(hotelId, "apiRequests", 1).catch(() => undefined);

  return {
    ok: true,
    auth: {
      keyId,
      hotelId,
      hotelName: record.hotel.name,
      hotelStatus: record.hotel.status,
      scopes: parseScopes(record.scopes),
    },
  };
}

export function requireScope(auth: ApiKeyAuth, scope: ApiKeyScopes): boolean {
  return auth.scopes.includes(scope);
}

/** Timing-safe string compare helper (defense in depth; keys are hashed anyway). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Does this hotel's plan include developer API access?
 * No plan (legacy) → allowed, to avoid locking existing tenants out.
 */
export async function planHasApiAccess(hotelId: string): Promise<boolean> {
  const hotel = await db.hotel.findUnique({
    where: { id: hotelId },
    select: { plan: { select: { apiAccess: true } } },
  });
  if (!hotel) return false;
  return hotel.plan ? hotel.plan.apiAccess === true : true;
}

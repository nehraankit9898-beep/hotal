import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import {
  generateApiKey,
  hashApiKey,
  displayPrefix,
  planHasApiAccess,
  type ApiKeyScopes,
} from "@/lib/api-keys";

/**
 * Phase 11 — Developer API keys.
 *
 * GET  /api/api-keys — list this hotel's keys (prefix only; full key is shown
 *                       exactly once by POST).
 * POST /api/api-keys — create a key { name, scopes: ["read"] | ["read","write"] }.
 *                      Gated by the plan's apiAccess flag.
 */

const MAX_KEYS_PER_HOTEL = 10;

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "SETTINGS_MANAGE");
    if (denied) return denied;

    const keys = await db.apiKey.findMany({
      where: { hotelId: auth.user.hotelId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        prefix: true,
        scopes: true,
        status: true,
        requests: true,
        lastUsedAt: true,
        createdAt: true,
        revokedAt: true,
      },
    });

    const apiAccess = await planHasApiAccess(auth.user.hotelId);

    return Response.json({
      apiAccess,
      keys: keys.map((k) => ({
        ...k,
        scopes: (() => {
          try {
            return JSON.parse(k.scopes);
          } catch {
            return ["read"];
          }
        })(),
      })),
    });
  } catch (err) {
    return serverError(err, "Could not load API keys. Please try again.");
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "SETTINGS_MANAGE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;

    const apiAccess = await planHasApiAccess(hotelId);
    if (!apiAccess) {
      return jsonError(
        "Developer API access is not included in your current plan. Upgrade to create API keys.",
        403,
        "FEATURE_DISABLED",
      );
    }

    const body = await readJson(req);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 60) {
      return jsonError(
        'Give the key a short name (1–60 characters), e.g. "POS terminal".',
        422,
        "VALIDATION_ERROR",
      );
    }

    const rawScopes: string[] = Array.isArray(body?.scopes) ? body.scopes : ["read"];
    const scopes: ApiKeyScopes[] = rawScopes.filter((s) => s === "read" || s === "write");
    if (scopes.length === 0) scopes.push("read");

    const count = await db.apiKey.count({ where: { hotelId, status: "ACTIVE" } });
    if (count >= MAX_KEYS_PER_HOTEL) {
      return jsonError(
        `You already have ${MAX_KEYS_PER_HOTEL} active keys. Revoke one before creating another.`,
        409,
        "KEY_LIMIT_REACHED",
      );
    }

    const key = generateApiKey();
    const record = await db.apiKey.create({
      data: {
        hotelId,
        name,
        prefix: displayPrefix(key),
        keyHash: hashApiKey(key),
        scopes: JSON.stringify(scopes),
        createdById: userId,
      },
    });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.API_KEY_CREATED,
      entityType: "api_key",
      entityId: record.id,
      metadata: { name, scopes },
    });

    return Response.json(
      {
        key: {
          id: record.id,
          name: record.name,
          prefix: record.prefix,
          scopes,
          createdAt: record.createdAt,
        },
        // The FULL key — shown exactly once.
        secret: key,
        notice: "Copy this key now — it will not be shown again.",
      },
      { status: 201 },
    );
  } catch (err) {
    return serverError(err, "Could not create the API key. Please try again.");
  }
}

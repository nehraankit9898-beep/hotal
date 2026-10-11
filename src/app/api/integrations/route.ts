import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { encryptCredentials, isEncryptedEnvelope } from "@/lib/crypto";
import { parseWith, integrationUpsertSchema } from "@/lib/validation";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { requestIp } from "@/lib/login-security";

/**
 * Integration credential management — Phase 4 (secured).
 *
 * - Credentials are AES-256-GCM encrypted at rest with the tenant context
 *   bound as AAD (src/lib/crypto.ts). Plaintext NEVER persists.
 * - API responses expose `hasCredentials: true/false` — never the credentials
 *   themselves, never encrypted blobs, never decryption material.
 * - Decryption happens server-side only (see getIntegrationSecrets below).
 */

/** GET /api/integrations — list integrations for the hotel (secrets masked). */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "INTEGRATION_READ");
    if (denied) return denied;

    const integrations = await db.integration.findMany({
      where: { hotelId: auth.user.hotelId },
      orderBy: { createdAt: "asc" },
    });

    return Response.json({
      integrations: integrations.map((i) => ({
        id: i.id,
        type: i.type,
        name: i.name,
        status: i.status,
        enabled: i.enabled,
        hasCredentials: Boolean(i.credentials),
        credentialEncrypted: isEncryptedEnvelope(i.credentials),
        lastSyncAt: i.lastSyncAt?.toISOString() ?? null,
        lastError: i.lastError,
        createdAt: i.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return serverError(err, "Integrations could not be loaded.");
  }
}

/** POST /api/integrations — create an integration (credentials encrypted at rest). */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "INTEGRATION_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    const parsed = parseWith(integrationUpsertSchema, body);
    if (!parsed.ok || !parsed.data) return jsonError(parsed.error ?? "Invalid request.");

    const { type, name, credentials, enabled } = parsed.data;
    if (credentials && Object.keys(credentials).length === 0) {
      return jsonError("Credentials cannot be an empty object.");
    }

    // Reject attempts to pass pre-encrypted blobs through user input.
    if (credentials && typeof (credentials as Record<string, unknown>).__raw === "string") {
      return jsonError("Invalid credentials payload.");
    }

    const encrypted =
      credentials && Object.keys(credentials).length > 0
        ? encryptCredentials({ hotelId: auth.user.hotelId, integrationType: type }, credentials)
        : null;

    // AUDIT FIX (F04): saving credentials does NOT prove the provider works.
    // The honest initial state is SAVED_UNVERIFIED (credentials encrypted at
    // rest) — promotion to VERIFIED happens ONLY via a real connectivity
    // check (POST /api/integrations/verify). Restaurants can no longer be
    // shown a fake "CONNECTED" badge for an invalid key.
    const integration = await db.integration.create({
      data: {
        hotelId: auth.user.hotelId,
        type,
        name,
        status: encrypted ? "SAVED_UNVERIFIED" : "PENDING",
        credentials: encrypted,
        enabled,
      },
    });

    await logAudit({
      req,
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: AUDIT_ACTIONS.INTEGRATION_CONNECTED,
      entityType: "integration",
      entityId: integration.id,
      metadata: {
        type,
        name,
        hasCredentials: Boolean(encrypted),
        credentialKeys: credentials ? Object.keys(credentials) : [],
      },
      ipAddress: requestIp(req),
    });

    return Response.json(
      {
        integration: {
          id: integration.id,
          type: integration.type,
          name: integration.name,
          status: integration.status,
          enabled: integration.enabled,
          hasCredentials: Boolean(encrypted),
          createdAt: integration.createdAt.toISOString(),
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return serverError(err, "Integration could not be saved.");
  }
}

/** PATCH /api/integrations?id=<id> — rename/enable/disable or rotate credentials. */
export async function PATCH(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "INTEGRATION_MANAGE");
    if (denied) return denied;

    const id = new URL(req.url).searchParams.get("id");
    if (!id) return jsonError("Integration id is required.");

    // Tenant-scoped lookup first (Phase 6): foreign ids look like 404s.
    const existing = await db.integration.findFirst({ where: { id, hotelId: auth.user.hotelId } });
    if (!existing) return jsonError("Integration not found in your hotel.", 404, "NOT_FOUND");

    const body = await readJson(req);
    const parsed = parseWith(integrationUpsertSchema.partial(), body);
    if (!parsed.ok || !parsed.data) return jsonError(parsed.error ?? "Invalid request.");
    const { name, credentials, enabled } = parsed.data;

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (enabled !== undefined) {
      data.enabled = enabled;
      // AUDIT FIX (F04): disabling an integration must genuinely take it out
      // of the runtime send path (resolveTenantProvider skips non-enabled
      // rows) AND be reflected in the status the UI shows.
      if (!enabled) data.status = "DISCONNECTED";
      else if (existing.status === "DISCONNECTED")
        data.status = existing.credentials ? "SAVED_UNVERIFIED" : "PENDING";
    }
    let rotated = false;
    if (credentials && Object.keys(credentials).length > 0) {
      data.credentials = encryptCredentials(
        { hotelId: auth.user.hotelId, integrationType: existing.type },
        credentials,
      );
      // AUDIT FIX (F04): rotated credentials are UNVERIFIED until a real
      // provider check passes — never silently re-badged CONNECTED.
      data.status = "SAVED_UNVERIFIED";
      data.lastError = null;
      rotated = true;
    }
    if (Object.keys(data).length === 0) return jsonError("Nothing to update.");

    const updated = await db.integration.update({ where: { id: existing.id }, data });

    await logAudit({
      req,
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: AUDIT_ACTIONS.INTEGRATION_UPDATED,
      entityType: "integration",
      entityId: updated.id,
      metadata: { fields: Object.keys(data), credentialsRotated: rotated },
      ipAddress: requestIp(req),
    });

    return Response.json({
      integration: {
        id: updated.id,
        type: updated.type,
        name: updated.name,
        status: updated.status,
        enabled: updated.enabled,
        hasCredentials: Boolean(updated.credentials),
      },
    });
  } catch (err) {
    return serverError(err, "Integration could not be updated.");
  }
}

/** DELETE /api/integrations?id=<id> — remove an integration and its secrets. */
export async function DELETE(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "INTEGRATION_MANAGE");
    if (denied) return denied;

    const id = new URL(req.url).searchParams.get("id");
    if (!id) return jsonError("Integration id is required.");

    const existing = await db.integration.findFirst({ where: { id, hotelId: auth.user.hotelId } });
    if (!existing) return jsonError("Integration not found in your hotel.", 404, "NOT_FOUND");

    await db.integration.delete({ where: { id: existing.id } });

    await logAudit({
      req,
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: AUDIT_ACTIONS.INTEGRATION_DELETED,
      entityType: "integration",
      entityId: existing.id,
      metadata: { type: existing.type, name: existing.name },
      ipAddress: requestIp(req),
    });

    return Response.json({ ok: true });
  } catch (err) {
    return serverError(err, "Integration could not be deleted.");
  }
}

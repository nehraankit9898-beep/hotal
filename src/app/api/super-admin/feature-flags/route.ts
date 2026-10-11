import { NextResponse } from "next/server";
import { readJson, jsonError, serverError, requireSuperAdminSession } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { processScheduledGlobalFlags } from "@/lib/saas/entitlements";

/**
 * Global feature flags — Phase 9 §8 + Phase 10 §11 (Super Admin only).
 *   GET /api/super-admin/feature-flags            → global flags + tenant overrides
 *   PUT /api/super-admin/feature-flags            → toggle / schedule / force
 *        { key, enabled?, force?, activateAt?, deactivateAt?, notes?, hotelId? }
 * When `hotelId` is given, the request manages the PER-HOTEL override instead.
 */
export async function GET(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    await processScheduledGlobalFlags(); // apply due schedule transitions
    const [globals, tenantFlags, hotels] = await Promise.all([
      db.globalFeatureFlag.findMany({ orderBy: { key: "asc" } }),
      db.tenantFeature.findMany({ take: 5000 }),
      db.hotel.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    return NextResponse.json({
      globals: globals.map((g) => ({
        id: g.id,
        key: g.key,
        description: g.description,
        enabled: g.enabled,
        force: g.force,
        activateAt: g.activateAt?.toISOString() ?? null,
        deactivateAt: g.deactivateAt?.toISOString() ?? null,
        notes: g.notes,
        updatedAt: g.updatedAt.toISOString(),
      })),
      tenantFlags: tenantFlags.map((t) => ({
        hotelId: t.hotelId,
        featureKey: t.featureKey,
        enabled: t.enabled,
        updatedAt: t.updatedAt.toISOString(),
      })),
      hotels: hotels.map((h) => ({ id: h.id, name: h.name })),
    });
  } catch (err) {
    return serverError(err, "Could not load feature flags.");
  }
}

export async function PUT(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const body = await readJson(req);
    const key = typeof body?.key === "string" ? body.key.trim().toUpperCase() : "";
    if (!/^[A-Z0-9_]{2,60}$/.test(key)) {
      return jsonError(
        "Feature key must be 2-60 uppercase letters/digits/underscores.",
        422,
        "VALIDATION_ERROR",
      );
    }
    const hotelId = typeof body?.hotelId === "string" ? body.hotelId : null;

    if (hotelId) {
      // Per-hotel override (Phase 9 §8)
      const hotel = await db.hotel.findUnique({ where: { id: hotelId } });
      if (!hotel) return jsonError("Hotel not found.", 404, "NOT_FOUND");
      const enabled = body?.enabled === true;
      const flag = await db.tenantFeature.upsert({
        where: { hotelId_featureKey: { hotelId, featureKey: key } },
        create: { hotelId, featureKey: key, enabled, updatedBy: guard.session.userId },
        update: { enabled, updatedBy: guard.session.userId },
      });
      await logAudit({
        hotelId,
        userId: guard.session.userId,
        action: AUDIT_ACTIONS.FEATURE_TOGGLED,
        entityType: "tenant_feature",
        entityId: `${hotelId}:${key}`,
        metadata: { enabled, key },
        req,
      });
      return NextResponse.json({ flag: { hotelId, featureKey: key, enabled: flag.enabled } });
    }

    // Global flag (with optional scheduling + emergency force)
    const data: Record<string, unknown> = {};
    if (body?.enabled !== undefined) data.enabled = body.enabled === true;
    if (body?.force !== undefined) data.force = body.force === true;
    if (body?.description !== undefined) data.description = String(body.description).slice(0, 300);
    if (body?.notes !== undefined) data.notes = String(body.notes).slice(0, 500);
    if (body?.activateAt !== undefined) {
      data.activateAt = body.activateAt ? new Date(String(body.activateAt)) : null;
    }
    if (body?.deactivateAt !== undefined) {
      data.deactivateAt = body.deactivateAt ? new Date(String(body.deactivateAt)) : null;
    }
    data.updatedBy = guard.session.userId;
    const flag = await db.globalFeatureFlag.upsert({
      where: { key },
      create: { key, ...(data as { enabled?: boolean; force?: boolean }) },
      update: data,
    });
    const scheduled = Boolean(flag.activateAt || flag.deactivateAt);
    await logAudit({
      userId: guard.session.userId,
      action: flag.enabled
        ? AUDIT_ACTIONS.GLOBAL_FEATURE_TOGGLED
        : AUDIT_ACTIONS.GLOBAL_FEATURE_TOGGLED,
      entityType: "global_feature_flag",
      entityId: key,
      metadata: { enabled: flag.enabled, force: flag.force, scheduled, key },
      req,
    });
    return NextResponse.json({
      flag: {
        key: flag.key,
        enabled: flag.enabled,
        force: flag.force,
        activateAt: flag.activateAt?.toISOString() ?? null,
        deactivateAt: flag.deactivateAt?.toISOString() ?? null,
      },
    });
  } catch (err) {
    return serverError(err, "Could not update the feature flag.");
  }
}

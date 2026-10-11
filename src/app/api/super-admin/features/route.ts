import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { requireSuperAdminSession } from "@/lib/api-helpers";
import { ensureDefaultFeatureFlags, DEFAULT_FEATURE_KEYS } from "@/lib/super-admin";
import { parseWith, featureToggleSchema } from "@/lib/validation";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

/**
 * GET /api/super-admin/features?id=<hotelId> — get feature flags for a hotel.
 * PUT /api/super-admin/features?id=<hotelId> — toggle a feature flag.
 */
export async function GET(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;

  try {
    const url = new URL(req.url);
    const hotelId = url.searchParams.get("id");
    if (!hotelId)
      return NextResponse.json(
        { error: { code: "BAD_REQUEST", message: "Hotel ID is required." } },
        { status: 400 },
      );

    const features = await ensureDefaultFeatureFlags(hotelId);

    return Response.json({
      features: features.map((f) => ({
        id: f.id,
        hotelId: f.hotelId,
        featureKey: f.featureKey,
        enabled: f.enabled,
        updatedAt: f.updatedAt.toISOString(),
      })),
      availableKeys: DEFAULT_FEATURE_KEYS,
    });
  } catch (err) {
    console.error("[super-admin/features GET] error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not load feature flags." } },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;

  try {
    const url = new URL(req.url);
    const hotelId = url.searchParams.get("id");
    if (!hotelId)
      return NextResponse.json(
        { error: { code: "BAD_REQUEST", message: "Hotel ID is required." } },
        { status: 400 },
      );

    const body = await req.json().catch(() => null);
    const parsed = parseWith(featureToggleSchema, body);
    if (!parsed.ok || !parsed.data) {
      return NextResponse.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: parsed.error ?? "featureKey and enabled are required.",
          },
        },
        { status: 400 },
      );
    }

    const updated = await db.tenantFeature.upsert({
      where: { hotelId_featureKey: { hotelId, featureKey: parsed.data.featureKey } },
      create: {
        hotelId,
        featureKey: parsed.data.featureKey,
        enabled: parsed.data.enabled,
        updatedBy: guard.session.userId,
      },
      update: { enabled: parsed.data.enabled, updatedBy: guard.session.userId },
    });

    await logAudit({
      req,
      hotelId,
      userId: guard.session.userId,
      action: AUDIT_ACTIONS.FEATURE_TOGGLED,
      entityType: "tenant_feature",
      entityId: updated.id,
      metadata: { featureKey: parsed.data.featureKey, enabled: parsed.data.enabled },
    });

    return Response.json({
      feature: { id: updated.id, featureKey: updated.featureKey, enabled: updated.enabled },
    });
  } catch (err) {
    console.error("[super-admin/features PUT] error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not update feature flag." } },
      { status: 500 },
    );
  }
}

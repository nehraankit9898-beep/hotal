/**
 * Phase 17 — White-label config API.
 * GET  /api/white-label          → current config
 * PATCH /api/white-label         → update branding
 * POST /api/white-label/domain   → set custom domain (returns verification token)
 * POST /api/white-label/verify   → mark domain verified (operator-side)
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { getWhiteLabelConfig, updateWhiteLabel, setCustomDomain, markDomainVerified } from "@/lib/white-label";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    if (auth.user.role === "SUPER_ADMIN") {
      return jsonError("White-label is tenant-only.", 403, "FORBIDDEN");
    }
    const config = await getWhiteLabelConfig(auth.user.hotelId);
    return jsonOk({
      brandName: config.brandName,
      logoUrl: config.logoUrl,
      primaryColor: config.primaryColor,
      accentColor: config.accentColor,
      customDomain: config.customDomain,
      domainVerified: config.domainVerified,
      removePlatformMarks: config.removePlatformMarks,
      featurePlanGated: config.featurePlanGated,
    });
  } catch (e) {
    return serverError(e);
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "WHITE_LABEL_MANAGE");
    if (denied) return denied;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    const updates: Parameters<typeof updateWhiteLabel>[1] = {};
    if (typeof body.brandName === "string") updates.brandName = body.brandName;
    if (typeof body.logoUrl === "string") updates.logoUrl = body.logoUrl;
    if (typeof body.primaryColor === "string") updates.primaryColor = body.primaryColor;
    if (typeof body.accentColor === "string") updates.accentColor = body.accentColor;
    if (typeof body.removePlatformMarks === "boolean") updates.removePlatformMarks = body.removePlatformMarks;
    const result = await updateWhiteLabel(auth.user, updates);
    if (!result.ok) return jsonError(result.error, result.status ?? 400, "WHITE_LABEL_ERROR");
    return jsonOk({ ok: true });
  } catch (e) {
    return serverError(e);
  }
}

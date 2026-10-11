/**
 * Phase 17 — Approve a privacy request.
 * POST /api/privacy-requests/[id]/approve { legalReviewBy }
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { approvePrivacyRequest } from "@/lib/privacy";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "PRIVACY_REQUEST_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    const legalReviewBy = typeof body.legalReviewBy === "string" ? body.legalReviewBy.slice(0, 120) : "";
    if (!legalReviewBy) return jsonError("legalReviewBy is required (name/role of reviewer).", 422, "VALIDATION_ERROR");
    const result = await approvePrivacyRequest(auth.user, id, legalReviewBy);
    if (!result.ok) return jsonError(result.error, result.status ?? 400, "PRIVACY_ERROR");
    return jsonOk({ ok: true });
  } catch (e) {
    return serverError(e);
  }
}

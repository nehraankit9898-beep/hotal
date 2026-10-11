/**
 * Phase 17 — Franchise detail / branch summary.
 * GET /api/franchise/[id] — organization summary + branches (admin-only).
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { getFranchiseBranchSummary } from "@/lib/franchise";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "FRANCHISE_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;
    const result = await getFranchiseBranchSummary(auth.user, id);
    if (!result.ok) return jsonError(result.error, result.status ?? 400, "FRANCHISE_ERROR");
    return jsonOk(result);
  } catch (e) {
    return serverError(e);
  }
}

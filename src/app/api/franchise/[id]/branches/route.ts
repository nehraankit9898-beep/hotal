/**
 * Phase 17 — Add a branch to a franchise organization.
 * POST /api/franchise/[id]/branches { hotelId } — admin-only.
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { addBranchToFranchise } from "@/lib/franchise";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "FRANCHISE_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    const hotelId = typeof body.hotelId === "string" ? body.hotelId : "";
    if (!hotelId) return jsonError("hotelId is required.", 422, "VALIDATION_ERROR");
    const result = await addBranchToFranchise(auth.user, id, hotelId);
    if (!result.ok) return jsonError(result.error, result.status ?? 400, "FRANCHISE_ERROR");
    return jsonOk({ ok: true });
  } catch (e) {
    return serverError(e);
  }
}

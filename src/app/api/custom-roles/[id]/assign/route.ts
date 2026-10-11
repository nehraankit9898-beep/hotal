/**
 * Phase 17 — Assign a custom role to a user.
 * POST /api/custom-roles/[id]/assign { userId } — bumps target tokenVersion.
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { assignCustomRole } from "@/lib/custom-roles";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOM_ROLE_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    const userId = typeof body.userId === "string" ? body.userId : "";
    if (!userId) return jsonError("userId is required.", 422, "VALIDATION_ERROR");
    const result = await assignCustomRole(auth.user, id, userId);
    if (!result.ok) return jsonError(result.error, result.status ?? 400, "CUSTOM_ROLE_ERROR");
    return jsonOk({ ok: true });
  } catch (e) {
    return serverError(e);
  }
}

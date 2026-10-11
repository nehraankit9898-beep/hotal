/**
 * Phase 17 — Execute a privacy DELETE request (DESTRUCTIVE — owner-only).
 * POST /api/privacy-requests/[id]/execute
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { executeDeleteRequest } from "@/lib/privacy";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "PRIVACY_REQUEST_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;
    const result = await executeDeleteRequest(auth.user, id);
    if (!result.ok) return jsonError(result.error, result.status ?? 400, "PRIVACY_ERROR");
    return jsonOk({ ok: true, summary: result.summary });
  } catch (e) {
    return serverError(e);
  }
}

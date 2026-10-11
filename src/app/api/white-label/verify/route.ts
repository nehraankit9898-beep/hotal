/**
 * Phase 17 — Mark domain verified (operator-side).
 * POST /api/white-label/verify { verified: true }
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { markDomainVerified } from "@/lib/white-label";

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "WHITE_LABEL_MANAGE");
    if (denied) return denied;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    const verified = typeof body.verified === "boolean" ? body.verified : true;
    const result = await markDomainVerified(auth.user, verified);
    if (!result.ok) return jsonError(result.error, result.status ?? 400, "WHITE_LABEL_ERROR");
    return jsonOk({ ok: true });
  } catch (e) {
    return serverError(e);
  }
}

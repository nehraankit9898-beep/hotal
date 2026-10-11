/**
 * Phase 17 — Set custom domain.
 * POST /api/white-label/domain { domain } → returns verification token.
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { setCustomDomain } from "@/lib/white-label";

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "WHITE_LABEL_MANAGE");
    if (denied) return denied;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    const domain = typeof body.domain === "string" ? body.domain : "";
    if (!domain) return jsonError("domain is required.", 422, "VALIDATION_ERROR");
    const result = await setCustomDomain(auth.user, domain);
    if (!result.ok) return jsonError(result.error, result.status ?? 400, "WHITE_LABEL_ERROR");
    return jsonOk({ token: result.token, instructions: `Add a TXT record _restroloop-verify.${domain} with value ${result.token}.` });
  } catch (e) {
    return serverError(e);
  }
}

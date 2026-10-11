import { NextResponse } from "next/server";
import { requireAuth, readJson, jsonError, serverError } from "@/lib/api-helpers";
import { disableMfa } from "@/lib/mfa";

/**
 * POST /api/mfa/disable — disable MFA; requires a fresh TOTP/backup code so a
 * stolen session alone cannot remove the second factor (Phase 10 §14).
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const body = await readJson(req);
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!code)
      return jsonError(
        "A valid authentication code is required to disable MFA.",
        422,
        "VALIDATION_ERROR",
      );
    const result = await disableMfa(auth.user.userId, code);
    if (!result.ok) return jsonError(result.error, 400, "MFA_DISABLE_FAILED");
    return NextResponse.json({ enabled: false });
  } catch (err) {
    return serverError(err, "Could not disable MFA. Please try again.");
  }
}

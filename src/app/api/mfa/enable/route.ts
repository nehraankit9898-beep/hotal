import { NextResponse } from "next/server";
import { requireAuth, readJson, jsonError, serverError } from "@/lib/api-helpers";
import { confirmMfaSetup } from "@/lib/mfa";

/**
 * POST /api/mfa/enable — confirm TOTP enrolment with a live code (Phase 10 §14).
 * Backup codes are returned exactly ONCE.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const body = await readJson(req);
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!/^\d{6}$/.test(code)) {
      return jsonError(
        "Enter the 6-digit code from your authenticator app.",
        422,
        "VALIDATION_ERROR",
      );
    }
    const result = await confirmMfaSetup(auth.user.userId, code);
    if (!result.ok) return jsonError(result.error, 400, "MFA_CONFIRM_FAILED");
    return NextResponse.json({ enabled: true, backupCodes: result.backupCodes });
  } catch (err) {
    return serverError(err, "Could not enable MFA. Please try again.");
  }
}

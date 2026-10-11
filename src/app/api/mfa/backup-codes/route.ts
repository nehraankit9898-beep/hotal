import { NextResponse } from "next/server";
import { requireAuth, readJson, jsonError, serverError } from "@/lib/api-helpers";
import { regenerateBackupCodes } from "@/lib/mfa";

/**
 * POST /api/mfa/backup-codes — regenerate single-use backup codes; requires a
 * fresh code, invalidates all previous ones (Phase 10 §14).
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const body = await readJson(req);
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!code)
      return jsonError("A valid authentication code is required.", 422, "VALIDATION_ERROR");
    const result = await regenerateBackupCodes(auth.user.userId, code);
    if (!result.ok) return jsonError(result.error, 400, "MFA_REGENERATE_FAILED");
    return NextResponse.json({ backupCodes: result.backupCodes });
  } catch (err) {
    return serverError(err, "Could not regenerate backup codes. Please try again.");
  }
}

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-helpers";
import { db } from "@/lib/db";

/**
 * GET /api/mfa — MFA status for the signed-in user (Phase 10 §14).
 */
export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = await db.user.findUnique({
    where: { id: auth.user.userId },
    select: { mfaEnabled: true, mfaBackupCodes: true },
  });
  let backupCodesRemaining = 0;
  if (user?.mfaBackupCodes) {
    try {
      backupCodesRemaining = (JSON.parse(user.mfaBackupCodes) as string[]).length;
    } catch {
      backupCodesRemaining = 0;
    }
  }
  return NextResponse.json({
    mfaEnabled: user?.mfaEnabled ?? false,
    backupCodesRemaining,
    mfaSetupRequired: auth.user.mfaSetupRequired,
  });
}

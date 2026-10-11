import { NextResponse } from "next/server";
import { requireAuth, serverError } from "@/lib/api-helpers";
import { beginMfaSetup } from "@/lib/mfa";

/**
 * POST /api/mfa/setup — begin TOTP enrolment (Phase 10 §14).
 * Returns the secret + QR data URL exactly ONCE; nothing is enabled until
 * the user confirms a live code at /api/mfa/enable.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const setup = await beginMfaSetup(auth.user.userId);
    return NextResponse.json({
      secret: setup.secret,
      otpauthUrl: setup.otpauthUrl,
      qrDataUrl: setup.qrDataUrl,
    });
  } catch (err) {
    return serverError(err, "Could not start MFA setup. Please try again.");
  }
}

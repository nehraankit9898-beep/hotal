import { db } from "@/lib/db";
import { verifyPassUpdate, renderPassPayload } from "@/lib/ai/wallet";
import { jsonError } from "@/lib/api-helpers";

/**
 * Phase 18 — public pass update channel (HMAC-protected).
 *
 * GET /api/wallet/pass/[serial]?token=<updateToken>&sig=<hmac>
 *
 * Returns the CURRENT loyalty state for the pass — this is the endpoint a
 * real Apple/Google wallet integration would poll/update through. Security:
 *  - serial + token + HMAC signature triple required (guess-resistant).
 *  - Revoked passes return the revoked status and no loyalty data.
 *  - No customer PII beyond first name — never phone/email.
 */
export async function GET(req: Request, ctx: { params: Promise<{ serial: string }> }) {
  const { serial } = await ctx.params;
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const sig = url.searchParams.get("sig") ?? "";

  if (!token) return jsonError("Missing pass token.", 401, "UNAUTHORIZED");

  const authSecret = process.env.AUTH_SECRET || process.env.DEV_AUTH_SECRET || "";
  if (!authSecret) return jsonError("Server not configured.", 503, "NOT_CONFIGURED");

  const pass = await db.walletPass.findUnique({ where: { serialNumber: serial } });
  if (!pass || pass.updateToken !== token) {
    return jsonError("Pass not found.", 404, "NOT_FOUND");
  }
  if (pass.status === "REVOKED") {
    return Response.json({ status: "REVOKED" }); // no loyalty data after revocation
  }
  if (!sig || !verifyPassUpdate(serial, token, sig, authSecret)) {
    return jsonError("Invalid signature.", 401, "UNAUTHORIZED");
  }

  const hotel = await db.hotel.findUnique({
    where: { id: pass.hotelId },
    select: { name: true, timezone: true },
  });
  const loyalty = await db.loyaltyAccount.findUnique({
    where: { hotelId_customerId: { hotelId: pass.hotelId, customerId: pass.customerId } },
  });
  const customer = await db.customer.findUnique({
    where: { id: pass.customerId },
    select: { name: true },
  });

  const payload = renderPassPayload(
    { serialNumber: pass.serialNumber, platform: pass.platform, status: pass.status, pointsAtIssue: pass.pointsAtIssue },
    { name: hotel?.name ?? "Restaurant", timezone: hotel?.timezone },
    { points: loyalty?.points ?? 0, tier: loyalty?.tier ?? "BRONZE" },
  );

  return Response.json({
    status: pass.status,
    memberFirstName: (customer?.name ?? "").split(" ")[0] || null, // first name only
    payload,
  });
}

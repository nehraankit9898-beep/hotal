import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { issuePass, WALLET_PROVIDER_STATUS, renderPassPayload } from "@/lib/ai/wallet";

/**
 * Phase 18 — loyalty wallet passes (records; provider status honest).
 *
 * GET  /api/wallet/passes — list tenant passes (AI_READ).
 * POST /api/wallet/passes — issue for a customer {customerId, platform?} (AI_MANAGE).
 *
 * The response ALWAYS includes providerStatus = BLOCKED_PROVIDER_ACCESS until
 * real Apple/Google credentials are configured — no fake integration claims.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AI_READ");
    if (denied) return denied;

    const passes = await db.walletPass.findMany({
      where: { hotelId: auth.user.hotelId },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { customer: { select: { name: true } } },
    });

    return Response.json({
      providerStatus: WALLET_PROVIDER_STATUS,
      passes: passes.map((p) => ({
        id: p.id,
        serialNumber: p.serialNumber,
        platform: p.platform,
        status: p.status,
        pointsAtIssue: p.pointsAtIssue,
        customerName: p.customer?.name ?? null,
        issuedAt: p.issuedAt,
        revokedAt: p.revokedAt,
      })),
    });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AI_MANAGE");
    if (denied) return denied;

    const body = (await readJson(req)) ?? {};
    const customerId = typeof body.customerId === "string" ? body.customerId : "";
    const platform = (["APPLE", "GOOGLE", "GENERIC"].includes(body.platform as string) ? body.platform : "GENERIC") as "APPLE" | "GOOGLE" | "GENERIC";
    if (!customerId) return jsonError("customerId is required.", 422, "MISSING_CUSTOMER");

    const result = await issuePass(auth.user.hotelId, customerId, platform);
    if (!result.ok) return Response.json({ error: result.message }, { status: result.status });

    // Attach the current pass payload (structure ready for a real adapter).
    const customer = await db.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    const loyalty = customer
      ? await db.loyaltyAccount.findUnique({ where: { hotelId_customerId: { hotelId: auth.user.hotelId, customerId } } })
      : null;
    const hotel = await db.hotel.findUnique({ where: { id: auth.user.hotelId }, select: { name: true } });
    const payload = renderPassPayload(
      { serialNumber: result.pass.serialNumber, platform: result.pass.platform, status: result.pass.status, pointsAtIssue: result.pass.pointsAtIssue },
      { name: hotel?.name ?? "Restaurant" },
      { points: loyalty?.points ?? 0, tier: loyalty?.tier ?? "BRONZE" },
    );

    return Response.json({ pass: result.pass, payload, providerStatus: WALLET_PROVIDER_STATUS }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}

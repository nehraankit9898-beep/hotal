import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { redeemReward } from "@/lib/loyalty";

/** POST /api/loyalty/redeem — redeem one reward for a customer (counter flow). */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "LOYALTY_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");
    const customerId = typeof body.customerId === "string" ? body.customerId : "";
    if (!customerId) return jsonError("Please select a customer.");

    const customer = await db.customer.findFirst({
      where: { id: customerId, hotelId: auth.user.hotelId },
      select: { id: true, name: true },
    });
    if (!customer) return jsonError("Customer not found in your hotel.", 404, "NOT_FOUND");

    const result = await redeemReward(auth.user.hotelId, customerId, {
      userId: auth.user.userId,
      req,
    });
    if (!result.ok) return jsonError(result.reason ?? "Redemption failed.");

    return Response.json(result);
  } catch (err) {
    return serverError(err, "Reward could not be redeemed. Please try again.");
  }
}

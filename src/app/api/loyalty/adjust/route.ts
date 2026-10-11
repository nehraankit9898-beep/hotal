import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { adjustPoints } from "@/lib/loyalty";

/** POST /api/loyalty/adjust — manual points adjustment (+/−) with reason. */
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
      select: { id: true },
    });
    if (!customer) return jsonError("Customer not found in your hotel.", 404, "NOT_FOUND");

    const points = Number(body.points);
    if (!Number.isInteger(points) || points === 0) {
      return jsonError("Points must be a non-zero whole number (use a negative number to deduct).");
    }
    if (Math.abs(points) > 100_000) return jsonError("Maximum adjustment is ±100,000 points.");

    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return jsonError("Please enter a reason for this adjustment.");

    const result = await adjustPoints(auth.user.hotelId, customerId, points, reason, {
      userId: auth.user.userId,
      req,
    });
    if (!result.ok) return jsonError(result.reason ?? "Adjustment failed.");

    return Response.json(result);
  } catch (err) {
    return serverError(err, "Points could not be adjusted. Please try again.");
  }
}

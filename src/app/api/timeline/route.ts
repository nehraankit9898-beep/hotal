import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { buildCustomerTimeline, addTimelineEvent } from "@/lib/timeline";

/** GET /api/timeline?customerId=X — full timeline for a customer */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOMER_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const customerId = url.searchParams.get("customerId");
    if (!customerId) return jsonError("Customer ID is required.");

    const customer = await db.customer.findFirst({
      where: { id: customerId, hotelId: auth.user.hotelId },
    });
    if (!customer) return jsonError("Customer not found.", 404, "NOT_FOUND");

    const timeline = await buildCustomerTimeline(customerId, auth.user.hotelId);

    return Response.json({ timeline });
  } catch (err) {
    return serverError(err, "Timeline could not be loaded.");
  }
}

/** POST /api/timeline — add a manual timeline note */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOMER_READ");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request.");

    const customerId = typeof body.customerId === "string" ? body.customerId : "";
    const label = typeof body.label === "string" ? body.label : "";
    const detail = typeof body.detail === "string" ? body.detail : undefined;
    if (!customerId || !label) return jsonError("customerId and label are required.");

    const customer = await db.customer.findFirst({
      where: { id: customerId, hotelId: auth.user.hotelId },
    });
    if (!customer) return jsonError("Customer not found in your hotel.", 404, "NOT_FOUND");

    const event = await addTimelineEvent({
      hotelId: auth.user.hotelId,
      customerId,
      type: (typeof body.type === "string" ? body.type : "ADMIN_NOTE") || "ADMIN_NOTE",
      label,
      detail,
      userId: auth.user.userId,
    });

    return Response.json({ event }, { status: 201 });
  } catch (err) {
    return serverError(err, "Timeline note could not be added.");
  }
}

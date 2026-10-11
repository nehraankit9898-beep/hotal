import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { refreshRestaurantSegments } from "@/lib/restaurant";

/** PUT /api/restaurant/segments/refresh — recompute all restaurant segments */
export async function PUT(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "RESTAURANT_WRITE");
    if (denied) return denied;

    await refreshRestaurantSegments(auth.user.hotelId);

    return Response.json({ ok: true, refreshedAt: new Date().toISOString() });
  } catch (err) {
    return serverError(err, "Could not refresh restaurant segments.");
  }
}

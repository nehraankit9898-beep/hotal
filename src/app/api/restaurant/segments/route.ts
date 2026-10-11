import { db } from "@/lib/db";
import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { ensureRestaurantSegments } from "@/lib/restaurant";

/** GET /api/restaurant/segments — list restaurant-only segments */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "RESTAURANT_READ");
    if (denied) return denied;

    const segments = await ensureRestaurantSegments(auth.user.hotelId);
    const members = await db.segmentMember.findMany({
      where: { segmentId: { in: segments.map((s) => s.id) } },
      select: { segmentId: true, customerId: true },
    });
    const countBySegment = new Map<string, number>();
    for (const m of members) {
      countBySegment.set(m.segmentId, (countBySegment.get(m.segmentId) ?? 0) + 1);
    }

    return Response.json({
      segments: segments.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        type: s.type,
        isSystem: s.isSystem,
        color: s.color,
        rule: s.rule,
        memberCount: countBySegment.get(s.id) ?? 0,
      })),
    });
  } catch (err) {
    return serverError(err, "Restaurant segments could not be loaded.");
  }
}

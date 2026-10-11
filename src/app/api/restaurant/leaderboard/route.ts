import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { restaurantLeaderboard } from "@/lib/restaurant";

import { maskPhoneDisplay } from "@/lib/phone";

/**
 * GET /api/restaurant/leaderboard — top restaurant customers by spend
 * Privacy (Phase 8.1 §9): phone numbers are MASKED server-side. Full phone
 * access stays behind the authorized customer-management flow (/api/customers,
 * /api/customers/[id]) — never in restaurant leaderboard responses.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "RESTAURANT_READ");
    if (denied) return denied;

    const leaderboard = await restaurantLeaderboard(auth.user.hotelId, 25);

    return Response.json({
      leaderboard: leaderboard.map((c, idx) => ({
        rank: idx + 1,
        id: c.id,
        name: c.name,
        phone: maskPhoneDisplay(c.phone),
        totalRestaurantVisits: c.totalRestaurantVisits,
        totalRestaurantSpend: c.totalRestaurantSpend,
        lastRestaurantVisit: c.lastRestaurantVisit?.toISOString() ?? null,
        vip: c.vip,
      })),
    });
  } catch (err) {
    return serverError(err, "Restaurant leaderboard could not be loaded.");
  }
}

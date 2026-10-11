import { NextResponse } from "next/server";
import { requireSuperAdminSession } from "@/lib/api-helpers";
import { activateHotel } from "@/lib/super-admin";

/** POST /api/super-admin/hotels/activate?id=<hotelId> */
export async function POST(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;

  try {
    const url = new URL(req.url);
    const hotelId = url.searchParams.get("id");
    if (!hotelId)
      return NextResponse.json(
        { error: { code: "BAD_REQUEST", message: "Hotel ID is required." } },
        { status: 400 },
      );

    const hotel = await activateHotel(hotelId, guard.session.userId);

    return Response.json({ hotel: { id: hotel.id, status: hotel.status } });
  } catch (err) {
    console.error("[super-admin/activate] error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not activate hotel." } },
      { status: 500 },
    );
  }
}

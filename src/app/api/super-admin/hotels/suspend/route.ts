import { NextResponse } from "next/server";
import { requireSuperAdminSession } from "@/lib/api-helpers";
import { suspendHotel } from "@/lib/super-admin";
import { z } from "zod";

const suspendSchema = z.object({
  reason: z.string().trim().min(3).max(500).optional(),
});

/** POST /api/super-admin/hotels/suspend?id=<hotelId> */
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

    const body = await req.json().catch(() => ({}));
    const parsed = suspendSchema.safeParse(body);
    const reason = parsed.success
      ? (parsed.data.reason ?? "Suspended by super admin")
      : "Suspended by super admin";

    await suspendHotel(hotelId, reason, guard.session.userId);

    // Revoke active staff sessions of the suspended hotel is inherent: the
    // hotel status check in requireAuth blocks them on their next request.
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[super-admin/hotels/suspend] error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not suspend hotel." } },
      { status: 500 },
    );
  }
}

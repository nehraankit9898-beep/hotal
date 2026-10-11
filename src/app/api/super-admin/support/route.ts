import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { requireSuperAdminSession } from "@/lib/api-helpers";
import { requestSupportAccess, expireStaleSupportSessions } from "@/lib/super-admin";
import { parseWith, supportAccessSchema } from "@/lib/validation";

/** GET /api/super-admin/support?id=<hotelId> — list support sessions */
export async function GET(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;

  try {
    const url = new URL(req.url);
    const hotelId = url.searchParams.get("id");
    await expireStaleSupportSessions();

    const where: Record<string, unknown> = {};
    if (hotelId) where.hotelId = hotelId;
    const sessions = await db.supportSession.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        hotel: { select: { name: true } },
        adminUser: { select: { name: true, email: true } },
      },
    });

    return Response.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        hotel: { id: s.hotelId, name: s.hotel?.name ?? null },
        adminUser: { name: s.adminUser.name, email: s.adminUser.email },
        reason: s.reason,
        durationMinutes: s.durationMinutes,
        startedAt: s.startedAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        endedAt: s.endedAt?.toISOString() ?? null,
        status: s.status,
      })),
    });
  } catch (err) {
    console.error("[super-admin/support GET] error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not load support sessions." } },
      { status: 500 },
    );
  }
}

/** POST /api/super-admin/support?id=<hotelId> — request new support access */
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
    const parsed = parseWith(supportAccessSchema, body);
    if (!parsed.ok || !parsed.data) {
      return NextResponse.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: parsed.error ?? "Reason and duration are required.",
          },
        },
        { status: 400 },
      );
    }

    const created = await requestSupportAccess({
      hotelId,
      adminUserId: guard.session.userId,
      reason: parsed.data.reason,
      durationMinutes: parsed.data.durationMinutes,
    });

    return Response.json(
      { session: { id: created.id, expiresAt: created.expiresAt.toISOString() } },
      { status: 201 },
    );
  } catch (err) {
    console.error("[super-admin/support POST] error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not request support access." } },
      { status: 500 },
    );
  }
}

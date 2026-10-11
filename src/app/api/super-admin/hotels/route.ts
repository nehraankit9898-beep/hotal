import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { requireSuperAdminSession } from "@/lib/api-helpers";
import { createHotelTenant, ensurePlansSeed } from "@/lib/super-admin";
import { parseWith, createHotelSchema } from "@/lib/validation";

/**
 * GET /api/super-admin/hotels — list all hotels (Super Admin only).
 * POST /api/super-admin/hotels — create a new hotel tenant. The owner account
 * is created PENDING and receives a ONE-TIME invitation token (Phase 3):
 * the owner chooses their own password on the activation screen. No default
 * passwords exist anywhere in the system.
 */
export async function GET(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;

  try {
    await ensurePlansSeed();

    const hotels = await db.hotel.findMany({
      include: {
        plan: true,
        users: {
          where: { role: "HOTEL_OWNER" },
          select: { id: true, name: true, email: true, status: true },
          take: 1,
        },
        _count: {
          select: {
            customers: true,
            users: true,
            campaigns: true,
            visits: true,
            restaurantVisits: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return Response.json({
      hotels: hotels.map((h) => ({
        id: h.id,
        name: h.name,
        address: h.address,
        city: h.city,
        state: h.state,
        country: h.country,
        phone: h.phone,
        email: h.email,
        website: h.website,
        gstin: h.gstin,
        timezone: h.timezone,
        currency: h.currency,
        status: h.status,
        plan: h.plan
          ? { id: h.plan.id, name: h.plan.name, monthlyPrice: h.plan.monthlyPrice }
          : null,
        owner: h.users[0] ?? null,
        counts: {
          customers: h._count.customers,
          staff: h._count.users,
          campaigns: h._count.campaigns,
          visits: h._count.visits,
          restaurantVisits: h._count.restaurantVisits,
        },
        createdAt: h.createdAt.toISOString(),
        updatedAt: h.updatedAt.toISOString(),
      })),
      plans: await db.plan.findMany({ orderBy: { monthlyPrice: "asc" } }),
    });
  } catch (err) {
    console.error("[super-admin/hotels GET] error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not load hotels." } },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;

  try {
    await ensurePlansSeed();
    const body = await req.json().catch(() => null);
    const parsed = parseWith(createHotelSchema, body);
    if (!parsed.ok || !parsed.data) {
      return NextResponse.json(
        { error: { code: "BAD_REQUEST", message: parsed.error ?? "Invalid request." } },
        { status: 400 },
      );
    }

    const result = await createHotelTenant({
      name: parsed.data.name,
      address: parsed.data.address,
      city: parsed.data.city,
      state: parsed.data.state,
      country: parsed.data.country,
      phone: parsed.data.phone,
      email: parsed.data.email,
      website: parsed.data.website,
      gstin: parsed.data.gstin,
      timezone: parsed.data.timezone,
      currency: parsed.data.currency,
      planName: parsed.data.planName,
      ownerName: parsed.data.ownerName,
      ownerEmail: parsed.data.ownerEmail,
      ownerPhone: parsed.data.ownerPhone,
      adminUserId: guard.session.userId,
    });

    return Response.json(
      {
        hotel: result.hotel,
        owner: result.owner,
        plan: result.plan.name,
        // One-time invitation link for the owner (Phase 3). The token is stored
        // hashed, expires in 72h, and works exactly once. Never a password.
        invitation: {
          activationUrl: result.invitation.activationPath,
          token: result.invitation.token,
          expiresAt: result.invitation.expiresAt.toISOString(),
          note: "Share this link with the hotel owner over a secure channel. It works once and expires in 72 hours.",
        },
      },
      { status: 201 },
    );
  } catch (err) {
    console.error("[super-admin/hotels POST] error:", err instanceof Error ? err.message : err);
    const message = err instanceof Error ? err.message : "Could not create hotel.";
    return NextResponse.json({ error: { code: "BAD_REQUEST", message } }, { status: 400 });
  }
}

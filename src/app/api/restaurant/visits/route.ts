import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { recordRestaurantVisit } from "@/lib/restaurant";
import { maskPhoneDisplay } from "@/lib/phone";
import { parseWith, restaurantVisitCreateSchema } from "@/lib/validation";

/** GET /api/restaurant/visits — list restaurant visits (phones masked — Phase 8.1 §1) */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "RESTAURANT_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      50,
      Math.max(5, parseInt(url.searchParams.get("pageSize") || "10", 10) || 10),
    );
    const customerId = url.searchParams.get("customerId");
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");

    const where: Record<string, unknown> = { hotelId: auth.user.hotelId };
    if (customerId) where.customerId = customerId;
    if (startDate || endDate) {
      where.visitDate = {};
      if (startDate) (where.visitDate as Record<string, unknown>).gte = new Date(startDate);
      if (endDate) (where.visitDate as Record<string, unknown>).lte = new Date(endDate);
    }

    const total = await db.restaurantVisit.count({ where });
    const visits = await db.restaurantVisit.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { visitDate: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return Response.json({
      visits: visits.map((v) => ({
        id: v.id,
        customerId: v.customerId,
        customer: {
          id: v.customer.id,
          name: v.customer.name,
          phone: maskPhoneDisplay(v.customer.phone),
        },
        visitDate: v.visitDate.toISOString(),
        tableNumber: v.tableNumber,
        guests: v.guests,
        orderAmount: v.orderAmount,
        foodCategory: v.foodCategory,
        favouriteItems: v.favouriteItems,
        source: v.source,
        notes: v.notes,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    return serverError(err, "Restaurant visits could not be loaded.");
  }
}

/** POST /api/restaurant/visits — record a new restaurant visit */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "RESTAURANT_WRITE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request.");

    // Tenant-owned customer resolution FIRST (same ordering as the original
    // route: a foreign/unknown customerId is a 404 — indistinguishable from
    // a disabled module), THEN the F18 schema validation on the resolved
    // tenant's data.
    const customerId = typeof body.customerId === "string" ? body.customerId : "";
    if (!customerId) return jsonError("Please select a customer.", 422, "VALIDATION_ERROR");

    const customer = await db.customer.findFirst({
      where: { id: customerId, hotelId: auth.user.hotelId },
    });
    if (!customer) return jsonError("Customer not found in your hotel.", 404, "NOT_FOUND");

    // AUDIT FIX (F18): shared Zod validation. Previously POST accepted
    // guests=-3 and a non-numeric orderAmount crashed with a 500 instead of
    // a clean 422 — create and PATCH now validate identically.
    const parsed = parseWith(restaurantVisitCreateSchema, body);
    if (!parsed.ok || !parsed.data)
      return jsonError(parsed.error ?? "Invalid visit data.", 422, "VALIDATION_ERROR");
    const input = parsed.data;

    const visitDate = input.visitDate ? new Date(input.visitDate) : new Date();
    if (isNaN(visitDate.getTime()))
      return jsonError("Visit date is invalid.", 422, "VALIDATION_ERROR");

    const visit = await recordRestaurantVisit({
      hotelId: auth.user.hotelId,
      customerId: customer.id,
      visitDate,
      tableNumber: input.tableNumber,
      guests: input.guests,
      orderAmount: input.orderAmount,
      foodCategory: input.foodCategory,
      favouriteItems: input.favouriteItems,
      source: input.source,
      notes: input.notes,
      userId: auth.user.userId,
    });

    return Response.json({ visit }, { status: 201 });
  } catch (err) {
    return serverError(err, "Restaurant visit could not be recorded.");
  }
}

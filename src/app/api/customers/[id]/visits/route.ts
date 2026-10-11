import { db } from "@/lib/db";
import {
  requireAuth,
  jsonError,
  readJson,
  serverError,
  getTenantCustomer,
} from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/customers/[id]/visits — visit history for a customer. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "VISIT_READ");
    if (denied) return denied;
    const { id } = await ctx.params;

    const customer = await getTenantCustomer(id, auth.user.hotelId);
    if (!customer) return jsonError("Customer not found in your hotel.", 404, "NOT_FOUND");

    const visits = await db.visit.findMany({
      where: { customerId: id, hotelId: auth.user.hotelId },
      orderBy: { checkin: "desc" },
    });

    return Response.json({
      visits,
      stats: {
        totalVisits: visits.length,
        firstVisit: visits.length ? visits[visits.length - 1].checkin : null,
        lastVisit: visits.length ? visits[0].checkin : null,
      },
    });
  } catch (err) {
    return serverError(err, "Could not load visits. Please try again.");
  }
}

/** POST /api/customers/[id]/visits — record a new visit (counts derived from records). */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "VISIT_CREATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const customer = await getTenantCustomer(id, hotelId);
    if (!customer) return jsonError("Customer not found in your hotel.", 404, "NOT_FOUND");

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const checkinStr = typeof body.checkin === "string" ? body.checkin : "";
    const checkoutStr = typeof body.checkout === "string" ? body.checkout : "";
    const notes = typeof body.notes === "string" ? body.notes.trim() : "";
    const amountRaw = body.amount;

    const checkin = new Date(checkinStr);
    if (!checkinStr || isNaN(checkin.getTime())) {
      return jsonError("Please provide a valid check-in date and time.");
    }
    if (checkin.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      return jsonError("Check-in date cannot be in the future.");
    }

    let checkout: Date | null = null;
    if (checkoutStr) {
      checkout = new Date(checkoutStr);
      if (isNaN(checkout.getTime())) return jsonError("Please provide a valid check-out date.");
      if (checkout < checkin) return jsonError("Check-out cannot be before check-in.");
    }
    if (notes.length > 500) return jsonError("Notes are too long (max 500 characters).");

    let amount: number | null = null;
    if (amountRaw !== undefined && amountRaw !== null && amountRaw !== "") {
      amount = Number(amountRaw);
      if (!Number.isFinite(amount) || amount < 0) {
        return jsonError("Please enter a valid spend amount.");
      }
    }

    const visit = await db.visit.create({
      data: {
        hotelId,
        customerId: customer.id,
        checkin,
        checkout,
        source: "MANUAL",
        notes: notes || null,
        amount,
      },
    });

    // Derive counts from records (no duplicated counters)
    const count = await db.visit.count({ where: { customerId: customer.id } });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.VISIT_CREATED,
      entityType: "visit",
      entityId: visit.id,
      metadata: { customerId: customer.id, customerName: customer.name, totalVisits: count },
    });

    return Response.json({ visit, totalVisits: count }, { status: 201 });
  } catch (err) {
    return serverError(err, "Visit could not be saved. Please check the details and try again.");
  }
}

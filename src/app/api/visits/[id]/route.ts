import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/visits/[id] — edit a visit (hotel-scoped). */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "VISIT_UPDATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    // Multi-tenant isolation
    const visit = await db.visit.findFirst({ where: { id, hotelId } });
    if (!visit) return jsonError("Visit not found in your hotel.", 404, "NOT_FOUND");

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const data: Record<string, unknown> = {};

    if (body.checkin !== undefined) {
      const checkin = new Date(String(body.checkin));
      if (isNaN(checkin.getTime()))
        return jsonError("Please provide a valid check-in date and time.");
      data.checkin = checkin;
    }
    if (body.checkout !== undefined) {
      if (body.checkout === null || body.checkout === "") {
        data.checkout = null;
      } else {
        const checkout = new Date(String(body.checkout));
        if (isNaN(checkout.getTime())) return jsonError("Please provide a valid check-out date.");
        const checkin = data.checkin ? (data.checkin as Date) : visit.checkin;
        if (checkout < checkin) return jsonError("Check-out cannot be before check-in.");
        data.checkout = checkout;
      }
    }
    if (body.notes !== undefined) {
      const notes = typeof body.notes === "string" ? body.notes.trim() : "";
      if (notes.length > 500) return jsonError("Notes are too long (max 500 characters).");
      data.notes = notes || null;
    }
    if (body.amount !== undefined) {
      if (body.amount === null || body.amount === "") {
        data.amount = null;
      } else {
        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount < 0) {
          return jsonError("Please enter a valid spend amount.");
        }
        data.amount = amount;
      }
    }

    if (Object.keys(data).length === 0) return jsonError("Nothing to update.");

    const updated = await db.visit.update({ where: { id: visit.id }, data });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.VISIT_UPDATED,
      entityType: "visit",
      entityId: visit.id,
      metadata: { fields: Object.keys(data) },
    });

    return Response.json({ visit: updated });
  } catch (err) {
    return serverError(err, "Visit could not be updated. Please try again.");
  }
}

/** DELETE /api/visits/[id] — delete an incorrectly recorded visit. */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "VISIT_DELETE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const visit = await db.visit.findFirst({
      where: { id, hotelId },
      include: { customer: { select: { id: true, name: true } } },
    });
    if (!visit) return jsonError("Visit not found in your hotel.", 404, "NOT_FOUND");

    await db.visit.delete({ where: { id: visit.id } });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.VISIT_DELETED,
      entityType: "visit",
      entityId: visit.id,
      metadata: { customerId: visit.customerId, customerName: visit.customer.name },
    });

    return Response.json({ ok: true, message: "Visit deleted." });
  } catch (err) {
    return serverError(err, "Visit could not be deleted. Please try again.");
  }
}

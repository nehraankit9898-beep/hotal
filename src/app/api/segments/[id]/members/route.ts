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

/** POST /api/segments/[id]/members — add a customer to a MANUAL segment. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "SEGMENT_UPDATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const segment = await db.segment.findFirst({ where: { id, hotelId } });
    if (!segment) return jsonError("Segment not found in your hotel.", 404, "NOT_FOUND");
    if (segment.type !== "MANUAL") {
      return jsonError("Automatic segment membership is managed by the engine.", 400, "READ_ONLY");
    }

    const body = await readJson(req);
    const customerId = body && typeof body.customerId === "string" ? body.customerId : null;
    if (!customerId) return jsonError("Please choose a customer to add.");

    const customer = await getTenantCustomer(customerId, hotelId);
    if (!customer) return jsonError("Customer not found in your hotel.", 404, "NOT_FOUND");

    const existing = await db.segmentMember.findUnique({
      where: { segmentId_customerId: { segmentId: id, customerId } },
    });
    if (existing) {
      return jsonError("This customer is already in the segment.", 409, "DUPLICATE_MEMBER");
    }

    await db.segmentMember.create({
      data: { segmentId: id, customerId, source: "MANUAL" },
    });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.SEGMENT_MEMBER_ADDED,
      entityType: "segment",
      entityId: id,
      metadata: { segment: segment.name, customerId },
    });

    return Response.json({ ok: true }, { status: 201 });
  } catch (err) {
    return serverError(err, "Customer could not be added to the segment. Please try again.");
  }
}

/** DELETE /api/segments/[id]/members?customerId=... — remove from MANUAL segment. */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "SEGMENT_UPDATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const segment = await db.segment.findFirst({ where: { id, hotelId } });
    if (!segment) return jsonError("Segment not found in your hotel.", 404, "NOT_FOUND");
    if (segment.type !== "MANUAL") {
      return jsonError("Automatic segment membership is managed by the engine.", 400, "READ_ONLY");
    }

    const url = new URL(req.url);
    const customerId = url.searchParams.get("customerId");
    if (!customerId) return jsonError("Please specify which customer to remove.");

    const existing = await db.segmentMember.findUnique({
      where: { segmentId_customerId: { segmentId: id, customerId } },
    });
    if (!existing) return jsonError("This customer is not in the segment.", 404, "NOT_FOUND");

    await db.segmentMember.delete({ where: { id: existing.id } });
    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.SEGMENT_MEMBER_REMOVED,
      entityType: "segment",
      entityId: id,
      metadata: { segment: segment.name, customerId },
    });

    return Response.json({ ok: true });
  } catch (err) {
    return serverError(err, "Customer could not be removed from the segment. Please try again.");
  }
}

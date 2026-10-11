import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { loadCustomerIntelligence } from "@/lib/segments";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/segments/[id] — segment detail + members (AUTO rules evaluated live). */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "SEGMENT_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;
    const { id } = await ctx.params;

    const segment = await db.segment.findFirst({ where: { id, hotelId } });
    if (!segment) return jsonError("Segment not found in your hotel.", 404, "NOT_FOUND");

    const memberRows = await db.segmentMember.findMany({
      where: { segmentId: segment.id },
      select: { customerId: true, source: true },
    });
    const manualIds = new Set(
      memberRows.filter((m) => m.source === "MANUAL").map((m) => m.customerId),
    );

    let members: {
      id: string;
      name: string;
      phone: string;
      email: string | null;
      totalVisits: number;
      totalSpend: number;
      lastVisitAt: string | null;
      vip: boolean;
      campaignEligible: boolean;
      membershipSource: string;
    }[] = [];

    if (segment.type === "AUTO" && segment.rule) {
      const intel = await loadCustomerIntelligence(hotelId);
      const { matchesRule, parseRuleSafe } = await import("@/lib/segments");
      const rule = parseRuleSafe(segment.rule);
      if (rule) {
        members = intel
          .filter((c) => matchesRule(c, rule))
          .map((c) => ({
            id: c.id,
            name: c.name,
            phone: c.phone,
            email: c.email,
            totalVisits: c.totalVisits,
            totalSpend: c.totalSpend,
            lastVisitAt: c.lastVisitAt ? c.lastVisitAt.toISOString() : null,
            vip: c.vip,
            campaignEligible: c.marketingConsent && !c.optOut && c.status === "ACTIVE",
            membershipSource: manualIds.has(c.id) ? "MANUAL" : "AUTO",
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      }
    } else {
      const customers = await db.customer.findMany({
        where: { hotelId, id: { in: [...manualIds] } },
        include: {
          visits: { select: { checkin: true, amount: true }, orderBy: { checkin: "asc" } },
        },
        orderBy: { name: "asc" },
      });
      members = customers.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        totalVisits: c.visits.length,
        totalSpend: c.visits.reduce((s, v) => s + (v.amount ?? 0), 0),
        lastVisitAt: c.visits.length ? c.visits[c.visits.length - 1].checkin.toISOString() : null,
        vip: c.vip,
        campaignEligible: c.marketingConsent && !c.optOut && c.status === "ACTIVE",
        membershipSource: "MANUAL",
      }));
    }

    return Response.json({
      segment: {
        id: segment.id,
        name: segment.name,
        description: segment.description,
        type: segment.type,
        isSystem: segment.isSystem,
        color: segment.color,
        rule: segment.rule ? JSON.parse(segment.rule) : null,
        createdAt: segment.createdAt,
      },
      members,
    });
  } catch (err) {
    return serverError(err, "Segment details could not be loaded. Please try again.");
  }
}

/** PATCH /api/segments/[id] — rename / describe a MANUAL segment. */
export async function PATCH(req: Request, ctx: Ctx) {
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
      return jsonError(
        "Automatic segments are managed by the engine and cannot be edited here.",
        400,
        "READ_ONLY",
      );
    }

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 2) return jsonError("Please enter a segment name (at least 2 characters).");
      const clash = await db.segment.findFirst({ where: { hotelId, name, NOT: { id } } });
      if (clash)
        return jsonError("A segment with this name already exists.", 409, "DUPLICATE_NAME");
      data.name = name;
    }
    if (body.description !== undefined) {
      data.description =
        typeof body.description === "string" ? body.description.trim().slice(0, 300) || null : null;
    }
    if (Object.keys(data).length === 0) return jsonError("Nothing to update.");

    const updated = await db.segment.update({ where: { id }, data });
    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.SEGMENT_UPDATED,
      entityType: "segment",
      entityId: id,
      metadata: { fields: Object.keys(data) },
    });
    return Response.json({ segment: updated });
  } catch (err) {
    return serverError(err, "Segment could not be updated. Please try again.");
  }
}

/** DELETE /api/segments/[id] — delete a MANUAL segment (system segments protected). */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "SEGMENT_DELETE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const segment = await db.segment.findFirst({ where: { id, hotelId } });
    if (!segment) return jsonError("Segment not found in your hotel.", 404, "NOT_FOUND");
    if (segment.isSystem || segment.type === "AUTO") {
      return jsonError("Automatic segments cannot be deleted.", 400, "PROTECTED");
    }

    await db.segment.delete({ where: { id } });
    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.SEGMENT_DELETED,
      entityType: "segment",
      entityId: id,
      metadata: { name: segment.name },
    });
    return Response.json({ ok: true, message: "Segment deleted." });
  } catch (err) {
    return serverError(err, "Segment could not be deleted. Please try again.");
  }
}

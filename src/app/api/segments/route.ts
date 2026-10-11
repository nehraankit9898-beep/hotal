import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { ensureSystemSegments, refreshAutoSegments, SYSTEM_SEGMENTS } from "@/lib/segments";
import type { SegmentRule } from "@/lib/segments";

/** GET /api/segments — all segments with member counts. */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "SEGMENT_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;

    await ensureSystemSegments(hotelId);
    const segments = await db.segment.findMany({
      where: { hotelId },
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    });

    const counts = await db.segmentMember.groupBy({
      by: ["segmentId"],
      where: { segmentId: { in: segments.map((s) => s.id) } },
      _count: { _all: true },
    });

    return Response.json({
      segments: segments.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        type: s.type,
        isSystem: s.isSystem,
        color: s.color,
        rule: s.rule ? (JSON.parse(s.rule) as SegmentRule) : null,
        memberCount: counts.find((c) => c.segmentId === s.id)?._count._all ?? 0,
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    return serverError(err, "Segments could not be loaded. Please try again.");
  }
}

/** POST /api/segments — create a manual segment. */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "SEGMENT_CREATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 2) return jsonError("Please enter a segment name (at least 2 characters).");
    if (name.length > 60) return jsonError("Segment name is too long (max 60 characters).");

    const description =
      typeof body.description === "string" ? body.description.trim().slice(0, 300) || null : null;

    const existing = await db.segment.findFirst({ where: { hotelId, name } });
    if (existing) {
      return jsonError("A segment with this name already exists.", 409, "DUPLICATE_NAME");
    }
    if (SYSTEM_SEGMENTS.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      return jsonError(
        "This name is reserved for an automatic segment. Please choose another.",
        409,
        "DUPLICATE_NAME",
      );
    }

    const segment = await db.segment.create({
      data: { hotelId, name, description, type: "MANUAL", isSystem: false },
    });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.SEGMENT_CREATED,
      entityType: "segment",
      entityId: segment.id,
      metadata: { name },
    });

    return Response.json({ segment }, { status: 201 });
  } catch (err) {
    return serverError(err, "Segment could not be created. Please try again.");
  }
}

/** PUT /api/segments — recompute all AUTO segments for this hotel. */
export async function PUT(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const { hotelId, userId } = auth.user;

    const results = await refreshAutoSegments(hotelId);

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.SEGMENTS_REFRESHED,
      entityType: "segment",
      metadata: { totalMembers: results.reduce((s, r) => s + r.memberCount, 0) },
    });

    return Response.json({ refreshed: results });
  } catch (err) {
    return serverError(err, "Segments could not be refreshed. Please try again.");
  }
}

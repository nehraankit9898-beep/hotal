import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { generateQrIdentifier, buildPublicUrl } from "@/lib/qr";

/**
 * QR code API — Phase 6.3
 * GET  /api/qr-codes        — list QR codes with join stats
 * POST /api/qr-codes        — create a new QR code (LOYALTY / MENU / FEEDBACK / ORDER)
 */

const VALID_TYPES = ["MENU", "LOYALTY", "FEEDBACK", "ORDER"] as const;
type QrType = (typeof VALID_TYPES)[number];

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "QR_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;

    const origin = new URL(req.url).origin;
    const codes = await db.qRCode.findMany({
      where: { hotelId },
      orderBy: { createdAt: "desc" },
    });

    return Response.json({
      qrCodes: codes.map((q) => ({
        id: q.id,
        code: q.code,
        type: q.type,
        label: q.label,
        active: q.active,
        scans: q.scans,
        joins: q.joins,
        lastScanAt: q.lastScanAt?.toISOString() ?? null,
        createdAt: q.createdAt.toISOString(),
        url: buildPublicUrl(q.code, origin),
      })),
    });
  } catch (err) {
    return serverError(err, "QR codes could not be loaded.");
  }
}

/** POST /api/qr-codes — generate a new QR code. */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "QR_MANAGE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const type = VALID_TYPES.includes(body.type as QrType) ? (body.type as QrType) : "LOYALTY";
    const label =
      typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : null;

    // Retry a few times in the (astronomically unlikely) collision case.
    let qr: Awaited<ReturnType<typeof db.qRCode.create>> | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        qr = await db.qRCode.create({
          data: { hotelId, code: generateQrIdentifier(), type, label },
        });
        break;
      } catch (e) {
        if (attempt === 4) throw e;
      }
    }
    if (!qr)
      return jsonError("QR code could not be generated. Please try again.", 500, "SERVER_ERROR");

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.QR_CREATED,
      entityType: "qr_code",
      entityId: qr.id,
      metadata: { type, label },
    });

    return Response.json(
      {
        qrCode: {
          id: qr.id,
          code: qr.code,
          type: qr.type,
          label: qr.label,
          active: qr.active,
          scans: qr.scans,
          joins: qr.joins,
          lastScanAt: null,
          createdAt: qr.createdAt.toISOString(),
          url: buildPublicUrl(qr.code, new URL(req.url).origin),
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return serverError(err, "QR code could not be created.");
  }
}

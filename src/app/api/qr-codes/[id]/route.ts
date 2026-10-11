import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { generateQrIdentifier, buildPublicUrl } from "@/lib/qr";

type Ctx = { params: Promise<{ id: string }> };

/**
 * QR code detail API — Phase 6.3
 * PATCH  /api/qr-codes/[id] — rename / enable / disable / regenerate
 * DELETE /api/qr-codes/[id] — delete (soft-equivalent: disabled QRs are useless)
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "QR_MANAGE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const qr = await db.qRCode.findFirst({ where: { id, hotelId } });
    if (!qr) return jsonError("QR code not found in your hotel.", 404, "NOT_FOUND");

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    let regenerated = false;
    let code = qr.code;

    if (body.regenerate === true) {
      // Regenerate the identifier: old printed codes stop working immediately.
      code = generateQrIdentifier();
      regenerated = true;
    }

    const updated = await db.qRCode.update({
      where: { id: qr.id },
      data: {
        ...(typeof body.active === "boolean" ? { active: body.active } : {}),
        ...(typeof body.label === "string"
          ? { label: body.label.trim().slice(0, 80) || null }
          : {}),
        ...(regenerated ? { code, scans: 0, joins: 0, lastScanAt: null } : {}),
      },
    });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.QR_UPDATED,
      entityType: "qr_code",
      entityId: updated.id,
      metadata: { active: updated.active, regenerated, label: updated.label },
    });

    return Response.json({
      qrCode: {
        id: updated.id,
        code: updated.code,
        type: updated.type,
        label: updated.label,
        active: updated.active,
        scans: updated.scans,
        joins: updated.joins,
        lastScanAt: updated.lastScanAt?.toISOString() ?? null,
        createdAt: updated.createdAt.toISOString(),
        url: buildPublicUrl(updated.code, new URL(req.url).origin),
      },
    });
  } catch (err) {
    return serverError(err, "QR code could not be updated.");
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "QR_MANAGE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const qr = await db.qRCode.findFirst({ where: { id, hotelId } });
    if (!qr) return jsonError("QR code not found in your hotel.", 404, "NOT_FOUND");

    await db.qRCode.delete({ where: { id: qr.id } });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.QR_DELETED,
      entityType: "qr_code",
      entityId: qr.id,
      metadata: { type: qr.type, label: qr.label },
    });

    return Response.json({ ok: true });
  } catch (err) {
    return serverError(err, "QR code could not be deleted.");
  }
}

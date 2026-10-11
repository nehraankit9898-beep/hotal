import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { generateQrIdentifier, buildPublicUrl } from "@/lib/qr";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH  /api/tables/[id] — edit number/capacity/zone (TABLE_MANAGE)
 * DELETE /api/tables/[id] — archive. Open sessions are closed first; the
 *         table's QR codes stay revocable history (deactivated).
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "TABLE_MANAGE");
    if (denied) return denied;
    const hotelId = auth.user.hotelId;
    const { id } = await ctx.params;

    const table = await db.diningTable.findFirst({
      where: { id, hotelId },
      select: { id: true },
    });
    if (!table) return jsonError("Table not found.", 404, "NOT_FOUND");

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const data: { number?: string; capacity?: number; zone?: string | null } = {};
    if (typeof body.number === "string") {
      const number = body.number.trim().toUpperCase();
      if (!/^[A-Z0-9-]{1,12}$/.test(number)) {
        return jsonError("Table number must be 1-12 letters/digits.");
      }
      const dupe = await db.diningTable.findFirst({
        where: { hotelId, number, id: { not: id } },
        select: { id: true },
      });
      if (dupe) return jsonError(`Table ${number} already exists.`, 409, "DUPLICATE");
      data.number = number;
    }
    if (body.capacity !== undefined) {
      const capacity = Number(body.capacity);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 30) {
        return jsonError("Capacity must be 1-30.");
      }
      data.capacity = capacity;
    }
    if (body.zone !== undefined) {
      data.zone =
        typeof body.zone === "string" && body.zone.trim() ? body.zone.trim().slice(0, 60) : null;
    }

    // Regenerate the table's ORDER QR (revocation + rebind): old code is
    // deactivated, a fresh unpredictable identifier is bound to the table.
    // D08 revocation policy: regenerating the QR also CLOSES the table's
    // OPEN sessions — a deauthorized printed QR must not keep sessions alive.
    let newQr: { code: string; url: string } | null = null;
    if (body.regenerateQr === true) {
      await db.$transaction(async (tx) => {
        await tx.qRCode.updateMany({
          where: { hotelId, tableId: id, active: true, type: { in: ["MENU", "ORDER"] } },
          data: { active: false },
        });
        // Resolve the CURRENT number for the label — `data.number ?? "Table"`
        // produced the "Table Table" label on regenerate-only PATCHes.
        const current = await tx.diningTable.findFirst({
          where: { id, hotelId },
          select: { number: true },
        });
        const qr = await tx.qRCode.create({
          data: {
            hotelId,
            code: generateQrIdentifier(),
            type: "ORDER",
            label: `Table ${data.number ?? current?.number ?? ""}`.trim(),
            tableId: id,
          },
        });
        // Close OPEN sessions (and release their (tableId, openFence) slot).
        await tx.tableSession.updateMany({
          where: { tableId: id, status: "OPEN" },
          data: { status: "CLOSED", closedAt: new Date(), openFence: null },
        });
        newQr = { code: qr.code, url: buildPublicUrl(qr.code, new URL(req.url).origin) };
      });
    }

    const updated = await db.diningTable
      .update({ where: { id }, data })
      .catch((err) => {
        // AUDIT FIX (P12-TBL-1): a concurrent rename to the same number hit
        // the DB unique fence with an unhandled P2002 (500). Integrity was
        // never at risk — surface it as the same 409 the pre-check produces.
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code?: string }).code === "P2002" &&
          data.number
        ) {
          return null;
        }
        throw err;
      });
    if (!updated) return jsonError(`Table ${String(data.number)} already exists.`, 409, "DUPLICATE");
    return Response.json({ table: updated, qr: newQr });
  } catch (err) {
    return serverError(err, "The table could not be updated.");
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "TABLE_MANAGE");
    if (denied) return denied;
    const hotelId = auth.user.hotelId;
    const { id } = await ctx.params;

    const result = await db.$transaction(async (tx) => {
      const table = await tx.diningTable.findFirst({
        where: { id, hotelId },
        select: { id: true },
      });
      if (!table) return false;
      // Close any open sessions so the floor map reflects reality.
      // AUDIT FIX (P12-TBL-2): release the (tableId, openFence) slot too —
      // the OPEN fence invariant (schema) requires openFence = NULL once a
      // session is closed, and a stale fence permanently occupied the unique
      // slot (a future restore/reopen would hit an unexplained P2002).
      await tx.tableSession.updateMany({
        where: { tableId: id, status: "OPEN" },
        data: { status: "CLOSED", closedAt: new Date(), openFence: null },
      });
      // Deactivate (revoke) bound QR codes — printed codes stop working.
      await tx.qRCode.updateMany({
        where: { hotelId, tableId: id, active: true },
        data: { active: false },
      });
      await tx.diningTable.update({ where: { id }, data: { active: false } });
      return true;
    });
    if (!result) return jsonError("Table not found.", 404, "NOT_FOUND");
    return Response.json({ ok: true, archived: true });
  } catch (err) {
    return serverError(err, "The table could not be archived.");
  }
}

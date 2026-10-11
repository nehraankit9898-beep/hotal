import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { generateQrIdentifier, buildPublicUrl } from "@/lib/qr";
import { withHotelWriteLock } from "@/lib/saas/limits";

/**
 * Phase 12 — dining tables.
 * GET  /api/tables — list with active-session state
 * POST /api/tables — create { number, capacity?, zone? } (optionally creates
 *                    the table's ORDER QR code in the same transaction)
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "TABLE_READ");
    if (denied) return denied;

    const origin = new URL(req.url).origin;
    const tables = await db.diningTable.findMany({
      where: { hotelId: auth.user.hotelId, active: true },
      orderBy: { number: "asc" },
      include: {
        sessions: {
          where: { status: "OPEN" },
          select: { id: true, openedAt: true, guestName: true },
        },
        qrCodes: {
          where: { active: true, type: { in: ["MENU", "ORDER"] } },
          select: { code: true, type: true },
        },
      },
    });

    return Response.json({
      tables: tables.map((t) => ({
        id: t.id,
        number: t.number,
        capacity: t.capacity,
        zone: t.zone,
        activeSession: t.sessions[0]
          ? {
              id: t.sessions[0].id,
              openedAt: t.sessions[0].openedAt.toISOString(),
              guestName: t.sessions[0].guestName,
            }
          : null,
        qr: t.qrCodes[0]
          ? { code: t.qrCodes[0].code, url: buildPublicUrl(t.qrCodes[0].code, origin) }
          : null,
      })),
    });
  } catch (err) {
    return serverError(err, "Tables could not be loaded.");
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "TABLE_MANAGE");
    if (denied) return denied;
    const hotelId = auth.user.hotelId;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const number = typeof body.number === "string" ? body.number.trim().toUpperCase() : "";
    if (!/^[A-Z0-9-]{1,12}$/.test(number)) {
      return jsonError("Table number must be 1-12 letters/digits (e.g. T1, A-12).");
    }
    const capacity = Number(body.capacity ?? 4);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 30) {
      return jsonError("Capacity must be 1-30.");
    }
    const zone =
      typeof body.zone === "string" && body.zone.trim() ? body.zone.trim().slice(0, 60) : null;

    // Duplicate table identity within tenant → the DB unique constraint is
    // the source of truth; catch it for a friendly message. The cap check
    // AND the create run inside the per-hotel write-locked transaction
    // (BUG-7/D17 — the old separate count+create race exceeded 200 tables).
    const buildTable = (tx: Parameters<Parameters<typeof withHotelWriteLock>[1]>[0]) =>
      tx.diningTable.create({
        data: {
          hotelId,
          number,
          capacity,
          zone,
          // Optionally bind a fresh ORDER QR to this table in the same txn —
          // the explicit relational binding (Phase 12 data model).
          ...(body.createQr !== false
            ? {
                qrCodes: {
                  create: {
                    hotelId,
                    code: generateQrIdentifier(),
                    type: "ORDER" as const,
                    label: `Table ${number}`,
                  },
                },
              }
            : {}),
        },
        include: { qrCodes: true },
      });

    let created: Awaited<ReturnType<typeof buildTable>> | null = null;
    try {
      created = await withHotelWriteLock(hotelId, async (tx) => {
        const count = await tx.diningTable.count({ where: { hotelId, active: true } });
        if (count >= 200) return null;
        return buildTable(tx);
      });
    } catch (err) {
      // The (hotelId, number) unique constraint fired between the pre-check
      // and the create → friendly duplicate message instead of a 500.
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
        return jsonError(`Table ${number} already exists.`, 409, "DUPLICATE");
      }
      throw err;
    }
    if (!created) {
      return jsonError("You can have up to 200 active tables.", 403, "PLAN_LIMIT");
    }
    const table = created;

    return Response.json(
      {
        table: {
          id: table.id,
          number: table.number,
          capacity: table.capacity,
          zone: table.zone,
          qr: table.qrCodes[0]
            ? {
                code: table.qrCodes[0].code,
                url: buildPublicUrl(table.qrCodes[0].code, new URL(req.url).origin),
              }
            : null,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return serverError(err, "The table could not be created.");
  }
}

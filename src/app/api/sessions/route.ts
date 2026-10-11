import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { openTableSession } from "@/lib/orders";

/**
 * Phase 13 — table sessions (waiter/floor workflow).
 *
 * GET  /api/sessions?status=OPEN — sessions with table + order summaries
 * POST /api/sessions — open (or reuse) a session for a table
 *                      { tableId, guestName?, guestPhone? }
 *
 * One OPEN session per table is enforced in openTableSession (create-if-none
 * with reuse). The session's publicToken is what a diner's QR flow uses for
 * order grouping — the waiter never handles it directly.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "TABLE_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const status = url.searchParams.get("status") === "CLOSED" ? "CLOSED" : "OPEN";

    const sessions = await db.tableSession.findMany({
      where: { hotelId: auth.user.hotelId, status },
      orderBy: { openedAt: "desc" },
      take: 100,
      include: {
        table: { select: { id: true, number: true, zone: true, capacity: true } },
        orders: {
          where: { status: { in: ["PLACED", "PREPARING", "READY"] } },
          select: {
            id: true,
            orderNumber: true,
            status: true,
            totalMinor: true,
            currency: true,
            placedAt: true,
          },
        },
      },
    });

    return Response.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        tableId: s.tableId,
        tableNumber: s.table?.number,
        zone: s.table?.zone,
        status: s.status,
        guestName: s.guestName,
        openedAt: s.openedAt.toISOString(),
        closedAt: s.closedAt?.toISOString() ?? null,
        activeOrders: s.orders.length,
        activeTotalMinor: s.orders.reduce((sum, o) => sum + o.totalMinor, 0),
      })),
    });
  } catch (err) {
    return serverError(err, "Table sessions could not be loaded.");
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "SESSION_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body || typeof body.tableId !== "string") {
      return jsonError("Send { tableId }.");
    }

    const session = await openTableSession(auth.user.hotelId, body.tableId, {
      name: typeof body.guestName === "string" ? body.guestName : null,
      phone: typeof body.guestPhone === "string" ? body.guestPhone : null,
    });
    return Response.json({ session }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message === "TABLE_NOT_FOUND") {
      return jsonError("Table not found.", 404, "NOT_FOUND");
    }
    return serverError(err, "The table session could not be opened.");
  }
}

import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { kdsQueue } from "@/lib/orders";

/**
 * GET /api/kds — the Kitchen Display System queue.
 *
 * Requires KDS_ACCESS (kitchen staff, managers, owners). Returns ACTIVE
 * orders (PLACED/PREPARING/READY) ordered oldest-first with per-item state,
 * table reference and minutes-since-placement — the data a kitchen screen
 * needs. Deliberately EXCLUDES customer contact data, marketing info and
 * financials: kitchen staff cannot access CRM or billing (enforced by field
 * selection here + the KITCHEN role's permission set).
 *
 * The client polls this endpoint (10 s default). Polling is the live-update
 * transport for Phase 13 (Next.js standalone has no WebSocket server; SSE
 * would hold a dev-server connection per screen — polling with ETag-less
 * small payloads is the reliable choice for the pilot, documented in the
 * handoff). Reconnect is trivial: the next poll IS the catch-up.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "KDS_ACCESS");
    if (denied) return denied;

    const queue = await kdsQueue(auth.user.hotelId);
    return Response.json(
      { queue, serverTime: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return serverError(err, "The kitchen queue could not be loaded.");
  }
}

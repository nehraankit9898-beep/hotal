import { db } from "@/lib/db";
import { jsonError, serverError } from "@/lib/api-helpers";
import { resolvePublicMenu } from "@/lib/menu";
import { openTableSession } from "@/lib/orders";
import { checkRateLimit } from "@/lib/rate-limit";
import { requestIp } from "@/lib/login-security";

/**
 * GET /api/public/menu/[code] — the PUBLIC mobile menu a QR code resolves to.
 *
 * Fully anonymous: no login needed to browse, no customer identity involved.
 * The QR code is the capability (32-char unpredictable identifier, revocable).
 * For a table-bound ORDER QR, the response bootstraps the table's OPEN
 * session (creating one if none exists) and returns a session token that the
 * cart submit uses — the diner never sees IDs of other tables or customers.
 *
 * Rate-limited per IP (public catalog endpoint). Responses contain ONLY
 * display-safe fields: no staff data, no tenant settings, no analytics.
 */
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await ctx.params;

    // Public endpoint: per-IP rate limit (catalog is read-only + cached by
    // the client; 60 scans/min/IP is far above human browsing).
    const burst = await checkRateLimit(`public-menu:${requestIp(req)}`, 60, 60 * 1000);
    if (!burst.allowed) {
      return jsonError("Too many requests. Please wait a moment.", 429, "RATE_LIMITED");
    }

    const menu = await resolvePublicMenu(code);
    if (!menu.ok) {
      const reason =
        menu.reason === "INVALID_CODE"
          ? "This QR code is not valid."
          : menu.reason === "NOT_MENU"
            ? "This QR code is not a menu code."
            : "This QR code is no longer active. Please ask the restaurant staff.";
      return jsonError(reason, menu.reason === "INVALID_CODE" ? 400 : 404, "MENU_UNAVAILABLE");
    }

    // Table-bound QR → bootstrap the dining session (order grouping context).
    // A MENU QR without a table binding is browse-only (no session).
    let session: { id: string; publicToken: string } | null = null;
    if (menu.table) {
      try {
        const s = await openTableSession(menu.restaurant.id, menu.table.id);
        session = { id: s.id, publicToken: s.publicToken };
      } catch {
        // Table archived between resolve and session open — menu still browsable.
        session = null;
      }
    }

    // Phase 18 — display-safe AI features for the public menu: optional
    // sustainability badges (always labelled SELF_REPORTED) and the voice-
    // cart toggle. Only these two flags are exposed — no tenant settings.
    const aiSettings = await db.aISettings.findUnique({
      where: { hotelId: menu.restaurant.id },
    }).catch(() => null);
    const sustainability = aiSettings?.sustainabilityEnabled
      ? await db.sustainabilityBadge.findMany({
          where: { hotelId: menu.restaurant.id, active: true },
          select: { label: true, description: true, methodRef: true, source: true },
          take: 10,
        })
      : [];

    return Response.json(
      {
        restaurant: menu.restaurant,
        table: menu.table,
        session,
        // Medium fix (item 5): `orderingEnabled` no longer LIES. It used to be
        // `menu.table !== null` — true even when the session bootstrap failed
        // or the table was archived, showing a cart that could never submit.
        // It is now true ONLY when a real OPEN session exists for an ACTIVE
        // table (createOrder re-validates both at submit time).
        orderingEnabled: session !== null,
        categories: menu.categories,
        // Phase 18 additions (display-safe only)
        voiceEnabled: aiSettings?.voiceEnabled === true,
        sustainability,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return serverError(err, "The menu could not be loaded.");
  }
}

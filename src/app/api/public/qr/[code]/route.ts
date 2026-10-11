import { resolvePublicQr } from "@/lib/qr";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

type Ctx = { params: Promise<{ code: string }> };

/**
 * Public QR resolution — Phase 6.3
 * GET /api/public/qr/[code] — restaurant landing page data for a scanned QR.
 * NO AUTH by design: anyone scanning the printed code must see the page.
 * Rate limited per IP; inactive/unknown codes get a generic, safe answer.
 */
export async function GET(req: Request, ctx: Ctx) {
  const ip = clientIp(req);
  const limit = await checkRateLimit(`public-qr:${ip}`, 60, 60_000);
  if (!limit.allowed) {
    return Response.json(
      { error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down." } },
      { status: 429 },
    );
  }

  const { code } = await ctx.params;
  const data = await resolvePublicQr(code);
  if (!data.ok) {
    return Response.json({ error: { code: "QR_INACTIVE", message: data.reason } }, { status: 404 });
  }
  return Response.json(data, {
    headers: { "Cache-Control": "no-store" },
  });
}

import { db } from "@/lib/db";
import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/bills/[id] — full bill detail (lines, payments, refunds). */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BILL_READ");
    if (denied) return denied;

    const { id } = await ctx.params;
    const bill = await db.bill.findFirst({
      where: { id, hotelId: auth.user.hotelId },
      include: {
        table: { select: { id: true, number: true, zone: true } },
        lines: { orderBy: { id: "asc" } },
        payments: { orderBy: { paidAt: "asc" } },
        refunds: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!bill) return jsonError("Bill not found.", 404, "NOT_FOUND");
    return Response.json({ bill });
  } catch (err) {
    return serverError(err);
  }
}

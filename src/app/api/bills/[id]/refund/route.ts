import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { refundOrVoidBill } from "@/lib/billing";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/bills/[id]/refund — owner/manager-authorized refund or void.
 * Requires BILL_REFUND (managers) for refunds; BILL_VOID (owner/admin only)
 * for voids. Reason is mandatory; issued history is never erased.
 *
 * Body: { type: "REFUND"|"VOID", amountMinor?, reason }
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;

    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");

    const type = body.type;
    if (type !== "REFUND" && type !== "VOID") {
      return jsonError("type must be REFUND or VOID.", 422, "INVALID_TYPE");
    }

    // Server-side split: REFUND → managers; VOID → owner/admin only.
    const deniedRefund = requirePermission(auth.user, "BILL_REFUND");
    if (deniedRefund) return deniedRefund;
    if (type === "VOID") {
      const deniedVoid = requirePermission(auth.user, "BILL_VOID");
      if (deniedVoid) return deniedVoid;
    }

    // BUG FIX: a negative or zero amount used to be silently clamped to 0 and then
    // reported as "Nothing left to refund". Invalid amounts are now rejected.
    let amountMinor: number | undefined;
    if (body.amountMinor !== undefined && body.amountMinor !== null) {
      if (
        typeof body.amountMinor !== "number" ||
        !Number.isSafeInteger(body.amountMinor) ||
        body.amountMinor <= 0
      ) {
        return jsonError(
          "amountMinor must be a positive whole number of minor units.",
          422,
          "INVALID_AMOUNT",
        );
      }
      amountMinor = body.amountMinor;
    }

    const result = await refundOrVoidBill({
      hotelId: auth.user.hotelId,
      billId: id,
      approvedByUserId: auth.user.userId,
      type,
      amountMinor,
      reason: typeof body.reason === "string" ? body.reason : "",
    });
    if (!result.ok) return jsonError(result.reason ?? "Refund rejected.", 422, "REFUND_REJECTED");
    return Response.json({ refund: result }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}

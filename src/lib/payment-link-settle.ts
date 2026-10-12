import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";

type LinkWriter = {
  paymentLink: {
    updateMany: (args: {
      where: { id: string; hotelId: string; billId: string; status?: { not: "PAID" } };
      data: { status: "PAID"; paidAt: Date };
    }) => Promise<{ count: number }>;
  };
};

/**
 * Mark a payment link PAID after its gateway capture has been allocated.
 *
 * PAY-001: the money is already captured and allocated to the bill at this
 * point, so a failed link update must never be swallowed. We retry briefly
 * (idempotent: only flips links that are not yet PAID) and, if it still fails,
 * record an audit event for reconciliation and return false so the caller can
 * answer with a retryable error. A client/provider retry is safe because
 * `recordGatewayCapture` is idempotent per intent.
 */
export async function settlePaymentLink(
  link: { id: string; hotelId: string; billId: string },
  opts: { attempts?: number; delayMs?: number; client?: LinkWriter; audit?: typeof logAudit } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 100;
  const client = opts.client ?? (db as unknown as LinkWriter);
  const audit = opts.audit ?? logAudit;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // count === 0 means a concurrent request already settled it — also fine.
      await client.paymentLink.updateMany({
        where: { id: link.id, hotelId: link.hotelId, billId: link.billId, status: { not: "PAID" } },
        data: { status: "PAID", paidAt: new Date() },
      });
      return true;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
  try {
    await audit({
      hotelId: link.hotelId,
      action: "PAYMENT_LINK_SETTLE_FAILED",
      entityType: "PaymentLink",
      entityId: link.id,
      metadata: {
        billId: link.billId,
        attempts,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      },
    });
  } catch {
    // Audit is best effort; the caller still reports failure.
  }
  return false;
}

/**
 * Link id recorded by our own checkout route in the intent's `meta`
 * (`{ kind: "LINK_INTENT", paymentLinkId }`). Read from OUR database row, never
 * from a webhook/client payload.
 */
export function paymentLinkIdFromIntentMeta(meta: string | null | undefined): string | null {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as { kind?: unknown; paymentLinkId?: unknown };
    return parsed.kind === "LINK_INTENT" && typeof parsed.paymentLinkId === "string" && parsed.paymentLinkId
      ? parsed.paymentLinkId
      : null;
  } catch {
    return null;
  }
}

/**
 * Settle the payment link (if any) that created this payment intent. Used by
 * the Razorpay webhook so a link settles even when the customer never returns
 * to the page. Returns true when there is nothing to settle or settling worked.
 */
export async function settlePaymentLinkForIntent(
  intent: { hotelId: string; billId: string; meta?: string | null },
  opts?: Parameters<typeof settlePaymentLink>[1],
): Promise<boolean> {
  const linkId = paymentLinkIdFromIntentMeta(intent.meta);
  if (!linkId) return true;
  return settlePaymentLink({ id: linkId, hotelId: intent.hotelId, billId: intent.billId }, opts);
}

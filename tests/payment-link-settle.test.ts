import { describe, expect, mock, test } from "bun:test";

// DB-free: @/lib/db is mocked and the writer is injected (PAY-001).
mock.module("@/lib/db", () => ({ db: {} }));
const { settlePaymentLink } = await import("@/lib/payment-link-settle");

const link = { id: "l1", hotelId: "h1", billId: "b1" };

describe("settlePaymentLink (PAY-001)", () => {
  test("retries a transient failure and then succeeds", async () => {
    let calls = 0;
    const client = { paymentLink: { updateMany: async () => { if (++calls < 3) throw new Error("timeout"); return { count: 1 }; } } };
    expect(await settlePaymentLink(link, { client, delayMs: 1 })).toBe(true);
    expect(calls).toBe(3);
  });

  test("persistent failure returns false and writes a reconciliation audit event", async () => {
    const client = { paymentLink: { updateMany: async () => { throw new Error("db down"); } } };
    const events: { action: string; entityId?: string }[] = [];
    const ok = await settlePaymentLink(link, { client, delayMs: 1, audit: async (e) => { events.push(e); } });
    expect(ok).toBe(false);
    expect(events).toEqual([expect.objectContaining({ action: "PAYMENT_LINK_SETTLE_FAILED", entityId: "l1" })]);
  });

  test("already-settled link (count 0) is idempotent success; only non-PAID links are targeted", async () => {
    let where: unknown;
    const client = { paymentLink: { updateMany: async (a: { where: unknown }) => { where = a.where; return { count: 0 }; } } };
    expect(await settlePaymentLink(link, { client })).toBe(true);
    expect(where).toEqual({ id: "l1", hotelId: "h1", billId: "b1", status: { not: "PAID" } });
  });

  test("verify route no longer swallows link update errors", async () => {
    const src = await Bun.file("src/app/api/pay/[token]/verify/route.ts").text();
    expect(src).not.toContain(".catch(() => undefined)");
    expect(src).toContain("LINK_SETTLE_PENDING");
  });
});

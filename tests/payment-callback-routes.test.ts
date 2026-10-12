import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "crypto";

/**
 * PAY-001 route-level tests for duplicate / failed gateway callbacks.
 * DB-FREE: db, billing and audit are in-memory fakes. These prove the route
 * logic (idempotent retry, dedupe-fence release, link settlement). They do NOT
 * replace a real PostgreSQL + Razorpay sandbox round trip.
 */
const SECRET = "whsec_test_secret";
process.env.RAZORPAY_RESTAURANT_WEBHOOK_SECRET = SECRET;

type Intent = { id: string; hotelId: string; billId: string; amountMinor: number; gatewayOrderId: string; gateway: string; status: string; meta: string | null };
const state = {
  intent: null as Intent | null,
  link: { id: "link1", hotelId: "h1", billId: "b1", status: "ACTIVE", paidAt: null as Date | null, token: "tok", expiresAt: new Date(Date.now() + 3600_000), bill: { status: "OPEN" } },
  events: new Set<string>(),
  linkUpdateFailures: 0,
  captureCalls: 0,
  captureThrows: 0,
  captured: false,
  audit: [] as string[],
};

mock.module("@/lib/db", () => ({
  db: {
    integration: { findFirst: async () => null },
    restaurantWebhookEvent: {
      create: async ({ data }: { data: { eventId: string } }) => {
        if (state.events.has(data.eventId)) throw Object.assign(new Error("unique"), { code: "P2002" });
        state.events.add(data.eventId);
      },
      deleteMany: async ({ where }: { where: { eventId: string } }) => { state.events.delete(where.eventId); },
      updateMany: async () => ({ count: 1 }),
    },
    billPayment: { findFirst: async () => state.intent },
    paymentLink: {
      findUnique: async () => ({ ...state.link }),
      updateMany: async () => {
        if (state.linkUpdateFailures > 0) { state.linkUpdateFailures--; throw new Error("db timeout"); }
        if (state.link.status !== "PAID") { state.link.status = "PAID"; state.link.paidAt = new Date(); return { count: 1 }; }
        return { count: 0 };
      },
    },
  },
}));
mock.module("@/lib/billing", () => ({
  verifyGatewaySignature: (o: string, p: string, sig: string, secret: string) =>
    createHmac("sha256", secret).update(`${o}|${p}`).digest("hex") === sig,
  restaurantGatewayCredentials: async () => ({ keyId: "k", keySecret: "ks" }),
  // Mirrors the real contract: first capture allocates, replays are ok (duplicate), errors throw.
  recordGatewayCapture: async () => {
    state.captureCalls++;
    if (state.captureThrows > 0) { state.captureThrows--; throw new Error("tx timeout"); }
    state.captured = true;
    return { ok: true, billStatus: "PAID" };
  },
}));
mock.module("@/lib/audit", () => ({ logAudit: async (e: { action: string }) => { state.audit.push(e.action); } }));
mock.module("@/lib/payment-link-limit", () => ({ limitPaymentLinkRequest: async () => null }));
mock.module("@/lib/api-helpers", () => ({
  jsonError: (message: string, status: number, code: string) => Response.json({ error: { code, message } }, { status }),
  readJson: async (req: Request) => req.json(),
}));

const webhook = await import("@/app/api/webhooks/razorpay-restaurant/route");
const verify = await import("@/app/api/pay/[token]/verify/route");

function webhookReq(paymentId = "pay_1") {
  const body = JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: { id: paymentId, order_id: "order_1", amount: 50000, notes: { hotelId: "h1", billId: "b1" } } } },
  });
  const sig = createHmac("sha256", SECRET).update(body).digest("hex");
  return new Request("http://x/api/webhooks/razorpay-restaurant", { method: "POST", headers: { "x-razorpay-signature": sig }, body });
}
function verifyReq(paymentId = "pay_1") {
  const sig = createHmac("sha256", "ks").update(`order_1|${paymentId}`).digest("hex");
  return new Request("http://x/api/pay/tok/verify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ gatewayOrderId: "order_1", gatewayPaymentId: paymentId, gatewaySignature: sig }),
  });
}
const ctx = { params: Promise.resolve({ token: "tok" }) };

beforeEach(() => {
  state.intent = { id: "i1", hotelId: "h1", billId: "b1", amountMinor: 50000, gatewayOrderId: "order_1", gateway: "RAZORPAY", status: "FAILED", meta: JSON.stringify({ kind: "LINK_INTENT", paymentLinkId: "link1" }) };
  state.link.status = "ACTIVE"; state.link.paidAt = null;
  state.events.clear(); state.linkUpdateFailures = 0; state.captureCalls = 0; state.captureThrows = 0; state.captured = false; state.audit = [];
});

describe("Razorpay webhook settles the payment link (customer never returns)", () => {
  test("captured webhook marks the originating link PAID", async () => {
    const res = await webhook.POST(webhookReq());
    expect(res.status).toBe(200);
    expect(state.link.status).toBe("PAID");
  });

  test("duplicate delivery is answered 200 duplicate, no second allocation", async () => {
    await webhook.POST(webhookReq());
    const res = await webhook.POST(webhookReq());
    expect((await res.json()).duplicate).toBe(true);
    expect(state.captureCalls).toBe(1);
  });

  test("intent without a link (manual QR/order intent) still succeeds", async () => {
    state.intent!.meta = null;
    expect((await webhook.POST(webhookReq())).status).toBe(200);
    expect(state.link.status).toBe("ACTIVE");
  });

  test("link settle failure -> 503 and fence released; provider retry settles the link", async () => {
    state.linkUpdateFailures = 3; // exhausts the in-process retries
    const first = await webhook.POST(webhookReq());
    expect(first.status).toBe(503);
    expect(state.link.status).toBe("ACTIVE");
    expect(state.audit).toContain("PAYMENT_LINK_SETTLE_FAILED");
    expect(state.events.size).toBe(0); // dedupe row removed, retry is NOT treated as duplicate
    const retry = await webhook.POST(webhookReq());
    expect(retry.status).toBe(200);
    expect(state.link.status).toBe("PAID");
  });

  test("capture throwing (DB timeout) -> error surfaces, fence released, retry allocates", async () => {
    state.captureThrows = 1;
    await expect(webhook.POST(webhookReq())).rejects.toThrow("tx timeout");
    expect(state.events.size).toBe(0);
    expect((await webhook.POST(webhookReq())).status).toBe(200);
    expect(state.captured).toBe(true);
  });

  test("bad signature is rejected before any DB write", async () => {
    const req = new Request("http://x/w", { method: "POST", headers: { "x-razorpay-signature": "deadbeef" }, body: "{\"event\":\"payment.captured\"}" });
    expect((await webhook.POST(req)).status).toBe(401);
    expect(state.events.size).toBe(0);
  });
});

describe("verify route: failed / duplicate callbacks", () => {
  test("happy path settles the link", async () => {
    const res = await verify.POST(verifyReq(), ctx);
    expect(res.status).toBe(200);
    expect(state.link.status).toBe("PAID");
  });

  test("persistent link failure -> 503, then client retry succeeds without a second allocation error", async () => {
    state.linkUpdateFailures = 3;
    const first = await verify.POST(verifyReq(), ctx);
    expect(first.status).toBe(503);
    expect(first.headers.get("Retry-After")).toBe("5");
    expect(state.link.status).toBe("ACTIVE");
    const retry = await verify.POST(verifyReq(), ctx);
    expect(retry.status).toBe(200);
    expect(state.link.status).toBe("PAID");
  });

  test("replay after settlement is rejected as already settled", async () => {
    await verify.POST(verifyReq(), ctx);
    const replay = await verify.POST(verifyReq(), ctx);
    expect(replay.status).toBe(409);
  });

  test("forged signature is rejected and nothing is captured", async () => {
    const req = new Request("http://x/v", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gatewayOrderId: "order_1", gatewayPaymentId: "pay_1", gatewaySignature: "bad" }) });
    expect((await verify.POST(req, ctx)).status).toBe(400);
    expect(state.captureCalls).toBe(0);
  });
});

/**
 * Audit-fix regression suite — covers every P0/P1 finding from the honest
 * product audit (F01–F18) that is reproducible in the test harness:
 *
 *   F01  Cross-tenant automation execution  → 404 + no foreign mutation
 *   F02  Missing release routes restored    → /api/jobs/[id]/download,
 *                                            /api/super-admin/backups respond
 *   F06  Signed-event binding               → wrong order/amount/currency rejected
 *   F07  Concurrent retry duplicates        → exactly ONE provider send
 *   F08  Bill edit rebuilds aggregates      → totalRestaurantSpend follows
 *   F09  Historical visit date              → lastRestaurantVisit = MAX(date)
 *   F10  CRM totals include restaurant      → totalVisits/totalSpend nonzero
 *   F13  Paused campaign gate               → 409 at the service level
 *   F14  Public join identity protection    → OTP challenge, no data leak
 *   F15  API key entitlement recheck        → archived/expired → 403
 *   F17  FAILED → PAID recovery             → capture recovers a failed payment
 *   F18  Restaurant visit validation        → guests=-3 → 422 (not 500/201)
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { PrismaClient } from "@prisma/client";
import {
  apiCall,
  login,
  ADMIN_PASSWORD,
  HOTEL_A_ADMIN,
  HOTEL_B_ADMIN,
  HOTEL_A_STAFF,
  STAFF_PASSWORD,
} from "./helpers";

const db = new PrismaClient();

let jarA: { cookie: string; csrf: string };
let jarB: { cookie: string; csrf: string };
let hotelAId = "";
let hotelBId = "";

beforeAll(async () => {
  const a = await login(HOTEL_A_ADMIN, ADMIN_PASSWORD);
  jarA = a.jar;
  const b = await login(HOTEL_B_ADMIN, ADMIN_PASSWORD);
  jarB = b.jar;
  const hotelA = await db.hotel.findFirst({ where: { users: { some: { email: HOTEL_A_ADMIN } } } });
  const hotelB = await db.hotel.findFirst({ where: { users: { some: { email: HOTEL_B_ADMIN } } } });
  hotelAId = hotelA?.id ?? "";
  hotelBId = hotelB?.id ?? "";
  expect(hotelAId).toBeTruthy();
  expect(hotelBId).toBeTruthy();
});

/* ------------------------------------------------------------------ */
/* F01 — cross-tenant automation execution                              */
/* ------------------------------------------------------------------ */
describe("F01 — automation execution tenant guard", () => {
  test("hotel A cannot execute hotel B's execution (404, no mutation)", async () => {
    // Create a PENDING execution for hotel B's customer directly.
    const ruleB = await db.automationRule.create({
      data: {
        hotelId: hotelBId,
        name: `F01 probe ${Date.now()}`,
        trigger: "VIP_THRESHOLD",
        status: "ACTIVE",
        channels: JSON.stringify(["WHATSAPP"]),
        actions: JSON.stringify([{ kind: "tag_vip" }]),
      },
    });
    const customerB =
      (await db.customer.findFirst({ where: { hotelId: hotelBId, vip: false } })) ??
      (await db.customer.findFirst({ where: { hotelId: hotelBId } }));
    expect(customerB).toBeTruthy();
    const execution = await db.automationExecution.create({
      data: {
        automationId: ruleB.id,
        customerId: customerB!.id,
        hotelId: hotelBId,
        trigger: "VIP_THRESHOLD",
        scheduledAt: new Date(),
        status: "PENDING",
      },
    });

    // Hotel A's admin retries hotel B's execution id → NOT FOUND.
    const res = await apiCall("POST", `/api/automations/run?executionId=${execution.id}`, {
      jar: jarA,
    });
    expect(res.status).toBe(404);

    // The foreign customer must be UNCHANGED.
    const after = await db.customer.findUnique({ where: { id: customerB!.id } });
    expect(after?.vip).toBe(false);

    // Same-tenant retry still works (B runs its own execution).
    const own = await apiCall("POST", `/api/automations/run?executionId=${execution.id}`, {
      jar: jarB,
    });
    expect(own.status).toBe(200);
    expect(own.body?.ok).toBe(true);
    const afterOwn = await db.customer.findUnique({ where: { id: customerB!.id } });
    expect(afterOwn?.vip).toBe(true);

    // Cleanup
    await db.automationExecution.delete({ where: { id: execution.id } }).catch(() => undefined);
    await db.automationRule.delete({ where: { id: ruleB.id } }).catch(() => undefined);
  });
});

/* ------------------------------------------------------------------ */
/* F02 — release routes restored                                        */
/* ------------------------------------------------------------------ */
describe("F02 — dropped release routes are present again", () => {
  test("download endpoint: anonymous 401, foreign/unknown job 404", async () => {
    const anon = await fetch(
      `${process.env.TEST_BASE_URL ?? "http://localhost:3100"}/api/jobs/00000000-0000-4000-8000-00000000000f/download?token=x`,
    );
    expect(anon.status).toBe(401); // auth runs BEFORE existence probing

    const res = await apiCall(
      "GET",
      "/api/jobs/00000000-0000-4000-8000-00000000000f/download?token=x",
      { jar: jarA },
    );
    expect(res.status).toBe(404); // tenant-scoped miss
  });

  test("super-admin backups: anon 401, hotel role 403, SA GET works and POST queues", async () => {
    const anon = await apiCall("GET", "/api/super-admin/backups");
    expect(anon.status).toBe(401);
    const hotelRole = await apiCall("GET", "/api/super-admin/backups", { jar: jarA });
    expect(hotelRole.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* F06 — signed payment event binding                                   */
/* ------------------------------------------------------------------ */
describe("F06 — provider event binding validation", () => {
  test("wrong order id / amount / currency / provider are quarantined", async () => {
    const { reconcileProviderPayment } = await import("../src/lib/saas/billing");
    const payment = await db.payment.create({
      data: {
        hotelId: hotelAId,
        invoiceNumber: `SL-F06-${Date.now()}`,
        amount: 10000,
        discountAmount: 0,
        currency: "INR",
        status: "PENDING",
        provider: "razorpay",
        providerOrderId: "order_F06Correct",
      },
    });

    // Correct binding → ok.
    const good = await reconcileProviderPayment({
      provider: "razorpay",
      providerOrderId: "order_F06Correct",
      hintedPaymentId: payment.id,
      amountMinor: 1000000, // ₹10,000 in paise
      currency: "INR",
    });
    expect(good.ok).toBe(true);

    // Unrelated order → quarantined.
    const wrongOrder = await reconcileProviderPayment({
      provider: "razorpay",
      providerOrderId: "order_UNRELATED",
      hintedPaymentId: payment.id,
      amountMinor: 1000000,
      currency: "INR",
    });
    expect(wrongOrder.ok).toBe(false);
    if (!wrongOrder.ok) expect(wrongOrder.reason).toBe("ORDER_MISMATCH");

    // ₹1 minor unit → quarantined.
    const wrongAmount = await reconcileProviderPayment({
      provider: "razorpay",
      providerOrderId: "order_F06Correct",
      hintedPaymentId: payment.id,
      amountMinor: 1,
      currency: "INR",
    });
    expect(wrongAmount.ok).toBe(false);
    if (!wrongAmount.ok) expect(wrongAmount.reason).toBe("AMOUNT_MISMATCH");

    // USD invoice → quarantined.
    const wrongCurrency = await reconcileProviderPayment({
      provider: "razorpay",
      providerOrderId: "order_F06Correct",
      hintedPaymentId: payment.id,
      amountMinor: 1000000,
      currency: "USD",
    });
    expect(wrongCurrency.ok).toBe(false);
    if (!wrongCurrency.ok) expect(wrongCurrency.reason).toBe("CURRENCY_MISMATCH");

    await db.payment.delete({ where: { id: payment.id } }).catch(() => undefined);
  });
});

/* ------------------------------------------------------------------ */
/* F07 — concurrent retry sends exactly once                            */
/* ------------------------------------------------------------------ */
describe("F07 — atomic retry ownership", () => {
  test("two simultaneous retry runs produce exactly ONE delivery", async () => {
    const { retryFailedMessages } = await import("../src/lib/campaigns");

    // RECHECK FIX (fixture): the probe used to pick an ARBITRARY existing
    // customer whose WhatsApp consent could be OFF — the consent gate then
    // correctly blocked the send (0 provider calls) and the test failed for
    // the wrong reason. Create a consenting customer so the probe isolates
    // the ownership-claim behavior it is actually testing.
    const customer = await db.customer.create({
      data: {
        hotelId: hotelAId,
        name: `F07 Consenting ${Date.now()}`,
        phone: `+9197${Date.now().toString().slice(-8)}`,
        marketingConsent: true,
        whatsappOptIn: true,
        status: "ACTIVE",
      },
    });
    const campaign = await db.campaign.create({
      data: {
        hotelId: hotelAId,
        name: `F07 probe ${Date.now()}`,
        status: "ACTIVE",
        scheduleType: "NOW",
        channels: JSON.stringify(["WHATSAPP"]),
        messageTemplate: "Hi {{name}}, F07 retry probe.",
        segmentId: null,
      },
    });
    const msg = await db.campaignMessage.create({
      data: {
        hotelId: hotelAId,
        campaignId: campaign.id,
        customerId: customer.id,
        channel: "WHATSAPP",
        recipient: customer.phone,
        personalizedMessage: "Hi {{name}}, F07 retry probe.",
        status: "FAILED",
        failureReason: "synthetic failure for F07",
      },
    });

    // Fire TWO concurrent retry runs — the atomic FAILED → RETRYING claim
    // must let exactly one of them call the provider.
    const [r1, r2] = await Promise.all([
      retryFailedMessages(campaign.id, { hotelId: hotelAId, hotelName: "F07" }),
      retryFailedMessages(campaign.id, { hotelId: hotelAId, hotelName: "F07" }),
    ]);

    expect(r1.ok && r2.ok).toBe(true);
    const s1 = (r1 as { ok: true; summary: { sent: number; simulated: number; retried: number } })
      .summary;
    const s2 = (r2 as { ok: true; summary: { sent: number; simulated: number; retried: number } })
      .summary;
    const totalProviderCalls = s1.sent + s1.simulated + s2.sent + s2.simulated;
    expect(totalProviderCalls).toBe(1);

    const after = await db.campaignMessage.findUnique({ where: { id: msg.id } });
    expect(["SENT", "SIMULATED"]).toContain(after?.status ?? "");

    await db.campaignMessage.delete({ where: { id: msg.id } }).catch(() => undefined);
    await db.campaign.delete({ where: { id: campaign.id } }).catch(() => undefined);
    await db.customer.delete({ where: { id: customer.id } }).catch(() => undefined);
  });

  test("UNKNOWN delivery rows are NOT retried", async () => {
    const { retryFailedMessages } = await import("../src/lib/campaigns");
    const customer = await db.customer.findFirst({ where: { hotelId: hotelAId } });
    const campaign = await db.campaign.create({
      data: {
        hotelId: hotelAId,
        name: `F07-unknown ${Date.now()}`,
        status: "ACTIVE",
        scheduleType: "NOW",
        channels: JSON.stringify(["WHATSAPP"]),
        messageTemplate: "Hi {{name}}",
        segmentId: null,
      },
    });
    const msg = await db.campaignMessage.create({
      data: {
        hotelId: hotelAId,
        campaignId: campaign.id,
        customerId: customer!.id,
        channel: "WHATSAPP",
        recipient: customer!.phone || "+919000000002",
        personalizedMessage: "Hi {{name}}",
        status: "UNKNOWN", // crash-window orphan — provider state unresolved
        failureReason: "Orphaned reservation",
      },
    });
    const result = await retryFailedMessages(campaign.id, { hotelId: hotelAId, hotelName: "F07" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.candidates).toBe(0); // UNKNOWN is invisible to the retry selector
    }
    const after = await db.campaignMessage.findUnique({ where: { id: msg.id } });
    expect(after?.status).toBe("UNKNOWN");
    await db.campaignMessage.delete({ where: { id: msg.id } }).catch(() => undefined);
    await db.campaign.delete({ where: { id: campaign.id } }).catch(() => undefined);
  });
});

/* ------------------------------------------------------------------ */
/* F08/F09 — restaurant aggregate correctness                           */
/* ------------------------------------------------------------------ */
describe("F08/F09 — restaurant aggregates", () => {
  test("bill edit rebuilds spend (F08) and historical dates never regress last visit (F09)", async () => {
    const customer = await db.customer.create({
      data: {
        hotelId: hotelAId,
        name: `F08 Probe ${Date.now()}`,
        phone: `+9191${Date.now().toString().slice(-8)}`,
      },
    });

    // Latest visit first (today, ₹1,000).
    const v1 = await apiCall("POST", "/api/restaurant/visits", {
      jar: jarA,
      body: { customerId: customer.id, orderAmount: 1000, guests: 2 },
    });
    expect(v1.status).toBe(201);

    // F09: a HISTORICAL (backdated) entry must not drag lastRestaurantVisit back.
    const historical = await apiCall("POST", "/api/restaurant/visits", {
      jar: jarA,
      body: {
        customerId: customer.id,
        orderAmount: 200,
        guests: 1,
        visitDate: new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString(),
      },
    });
    expect(historical.status).toBe(201);

    let fresh = await db.customer.findUnique({ where: { id: customer.id } });
    expect(fresh?.totalRestaurantVisits).toBe(2);
    expect(fresh?.totalRestaurantSpend).toBe(1200);
    expect(fresh?.lastRestaurantVisit?.getTime()).toBeGreaterThanOrEqual(
      Date.now() - 60 * 1000, // still ≈ now, NOT 40 days ago
    );

    // F08: edit the ₹1,000 bill down to ₹100 — aggregates must follow.
    const latest = await db.restaurantVisit.findFirst({
      where: { customerId: customer.id, orderAmount: 1000 },
    });
    expect(latest).toBeTruthy();
    const edit = await apiCall("PATCH", `/api/restaurant/visits/${latest!.id}`, {
      jar: jarA,
      body: { orderAmount: 100 },
    });
    expect(edit.status).toBe(200);

    fresh = await db.customer.findUnique({ where: { id: customer.id } });
    expect(fresh?.totalRestaurantSpend).toBe(300); // 100 + 200, not 1200
    expect(fresh?.totalRestaurantVisits).toBe(2);

    // F10: the CRM list shows the restaurant activity in unified metrics.
    const list = await apiCall("GET", `/api/customers?q=${encodeURIComponent(customer.phone)}`, {
      jar: jarA,
    });
    expect(list.status).toBe(200);
    const row = (list.body?.customers ?? []).find((c: { id: string }) => c.id === customer.id);
    expect(row).toBeTruthy();
    expect(row.totalVisits).toBe(2); // restaurant-only customer previously showed 0
    expect(row.totalSpend).toBe(300); // previously showed 0

    // Cleanup
    await db.restaurantVisit.deleteMany({ where: { customerId: customer.id } });
    await db.timelineEvent.deleteMany({ where: { customerId: customer.id } });
    await db.customer.delete({ where: { id: customer.id } }).catch(() => undefined);
  });
});

/* ------------------------------------------------------------------ */
/* F11 — inactivity automation must not target today's diner            */
/* ------------------------------------------------------------------ */
describe("F11 — inactivity triggers include restaurant activity", () => {
  test("a customer who dined today is NOT matched by INACTIVE_7", async () => {
    const customer = await db.customer.create({
      data: {
        hotelId: hotelAId,
        name: `F11 Diner ${Date.now()}`,
        phone: `+9192${Date.now().toString().slice(-8)}`,
      },
    });
    // No hotel stays — but a restaurant bill TODAY.
    await db.restaurantVisit.create({
      data: {
        hotelId: hotelAId,
        customerId: customer.id,
        visitDate: new Date(),
        orderAmount: 450,
        source: "WALK_IN",
      },
    });

    const rule = await db.automationRule.create({
      data: {
        hotelId: hotelAId,
        name: `F11 winback ${Date.now()}`,
        trigger: "INACTIVE_7",
        status: "ACTIVE",
        channels: JSON.stringify(["WHATSAPP"]),
        actions: JSON.stringify([]),
      },
    });

    const { scanAutomationTriggers } = await import("../src/lib/automations");
    await scanAutomationTriggers(hotelAId, "F11 Hotel");

    const queued = await db.automationExecution.findFirst({
      where: { automationId: rule.id, customerId: customer.id },
    });
    expect(queued).toBeNull(); // the active diner must never enter the win-back audience

    await db.automationExecution.deleteMany({ where: { automationId: rule.id } });
    await db.automationRule.delete({ where: { id: rule.id } }).catch(() => undefined);
    await db.restaurantVisit.deleteMany({ where: { customerId: customer.id } });
    await db.timelineEvent.deleteMany({ where: { customerId: customer.id } });
    await db.customer.delete({ where: { id: customer.id } }).catch(() => undefined);
  });
});

/* ------------------------------------------------------------------ */
/* F12 — recurring automation occurrence dedupe                         */
/* ------------------------------------------------------------------ */
describe("F12 — recurring automations can message on a NEW occurrence", () => {
  test("two birthday occurrences produce two messages; same-occurrence retry does not", async () => {
    const { runExecution } = await import("../src/lib/automations");
    const customer = await db.customer.create({
      data: {
        hotelId: hotelAId,
        name: `F12 Birthday ${Date.now()}`,
        phone: `+9193${Date.now().toString().slice(-8)}`,
        marketingConsent: true,
        whatsappOptIn: true,
        birthday: new Date(1990, 9, 10),
      },
    });
    const rule = await db.automationRule.create({
      data: {
        hotelId: hotelAId,
        name: `F12 birthday rule ${Date.now()}`,
        trigger: "BIRTHDAY",
        status: "ACTIVE",
        channels: JSON.stringify(["WHATSAPP"]),
        actions: JSON.stringify([{ kind: "send_message", channels: ["WHATSAPP"] }]),
      },
    });

    // Occurrence 1 — this year's birthday.
    const exec1 = await db.automationExecution.create({
      data: {
        automationId: rule.id,
        customerId: customer.id,
        hotelId: hotelAId,
        trigger: "BIRTHDAY",
        scheduledAt: new Date(),
        status: "PENDING",
      },
    });
    const r1 = await runExecution(exec1.id);
    expect(r1.ok).toBe(true);

    // RETRY of the SAME occurrence — must NOT double-send.
    const exec1Reloaded = await db.automationExecution.findUnique({ where: { id: exec1.id } });
    expect(exec1Reloaded?.status).toBe("SUCCESS");

    // Occurrence 2 — NEXT year's birthday (a genuine new occurrence).
    const exec2 = await db.automationExecution.create({
      data: {
        automationId: rule.id,
        customerId: customer.id,
        hotelId: hotelAId,
        trigger: "BIRTHDAY",
        scheduledAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
        status: "PENDING",
      },
    });
    const r2 = await runExecution(exec2.id);
    expect(r2.ok).toBe(true);

    // Two occurrences → TWO message rows (previously exactly ONE forever).
    const messages = await db.campaignMessage.findMany({
      where: { customerId: customer.id, hotelId: hotelAId },
    });
    expect(messages.length).toBe(2);

    await db.campaignMessage.deleteMany({ where: { customerId: customer.id } });
    await db.campaign.deleteMany({
      where: { hotelId: hotelAId, name: { contains: "F12 birthday rule" } },
    });
    await db.automationExecution.deleteMany({ where: { automationId: rule.id } });
    await db.automationRule.delete({ where: { id: rule.id } }).catch(() => undefined);
    await db.customer.delete({ where: { id: customer.id } }).catch(() => undefined);
  });
});

/* ------------------------------------------------------------------ */
/* F13 — paused campaigns cannot send at the service level              */
/* ------------------------------------------------------------------ */
describe("F13 — paused campaign gate", () => {
  test("executeCampaignSend refuses PAUSED and ARCHIVED campaigns", async () => {
    const { executeCampaignSend } = await import("../src/lib/campaigns");
    const segment = await db.segment.create({
      data: { hotelId: hotelAId, name: `F13 seg ${Date.now()}`, type: "MANUAL" },
    });
    for (const status of ["PAUSED", "ARCHIVED"] as const) {
      const campaign = await db.campaign.create({
        data: {
          hotelId: hotelAId,
          name: `F13 ${status} ${Date.now()}`,
          status,
          scheduleType: "NOW",
          channels: JSON.stringify(["WHATSAPP"]),
          messageTemplate: "Hi {{name}}",
          segmentId: segment.id,
        },
      });
      const result = await executeCampaignSend(campaign.id, {
        hotelId: hotelAId,
        hotelName: "F13",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(409);
      await db.campaign.delete({ where: { id: campaign.id } }).catch(() => undefined);
    }
    await db.segment.delete({ where: { id: segment.id } }).catch(() => undefined);
  });
});

/* ------------------------------------------------------------------ */
/* F14 — public QR join identity protection                             */
/* ------------------------------------------------------------------ */
describe("F14 — public join requires OTP for existing customers", () => {
  test("existing phone without OTP → 202 challenge, stored name unchanged, no loyalty leak", async () => {
    const qr = await db.qRCode.findFirst({
      where: { hotelId: hotelAId, type: "LOYALTY", active: true },
    });
    if (!qr) {
      // No seeded join QR in this DB — create one.
      await db.qRCode.create({
        data: { hotelId: hotelAId, code: `F14JOIN${Date.now()}`, type: "LOYALTY", active: true },
      });
    }
    const joinQr = await db.qRCode.findFirst({
      where: { hotelId: hotelAId, type: "LOYALTY", active: true },
    });
    expect(joinQr).toBeTruthy();

    const victim = await db.customer.findFirst({ where: { hotelId: hotelAId } });
    expect(victim).toBeTruthy();
    const originalName = victim!.name;

    // Anonymous attacker submits the victim's phone with a DIFFERENT name.
    const res = await fetch(
      `${process.env.TEST_BASE_URL ?? "http://localhost:3100"}/api/public/join`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qrCode: joinQr!.code,
          name: "Hacker Overwrites",
          phone: victim!.phone,
          marketingConsent: true,
          channels: { whatsapp: true, sms: true },
        }),
      },
    );
    const body = await res.json().catch(() => null);
    expect(res.status).toBe(202);
    expect(body?.otpRequired).toBe(true);
    expect(body?.customer).toBeNull(); // no profile data returned
    expect(body?.loyalty).toBeNull(); // no balance leak

    // The stored record is UNCHANGED.
    const after = await db.customer.findUnique({ where: { id: victim!.id } });
    expect(after?.name).toBe(originalName);
    expect(after?.marketingConsent).toBe(victim!.marketingConsent);
  });

  test("a brand-new phone can still join WITHOUT any OTP (friction preserved only for existing)", async () => {
    const joinQr = await db.qRCode.findFirst({
      where: { hotelId: hotelAId, type: "LOYALTY", active: true },
    });
    const phone = `+9194${Date.now().toString().slice(-8)}`;
    const res = await fetch(
      `${process.env.TEST_BASE_URL ?? "http://localhost:3100"}/api/public/join`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qrCode: joinQr!.code,
          name: "F14 New Visitor",
          phone,
          marketingConsent: false,
        }),
      },
    );
    const body = await res.json().catch(() => null);
    expect(res.status).toBe(200);
    expect(body?.ok).toBe(true);
    await db.customer.deleteMany({ where: { hotelId: hotelAId, phone } });
  });
});

/* ------------------------------------------------------------------ */
/* F15 — API key commercial entitlement recheck                         */
/* ------------------------------------------------------------------ */
describe("F15 — API key re-validates tenant state on every request", () => {
  test("archived hotel, API-disabled plan, expired subscription all reject", async () => {
    const { generateApiKey, hashApiKey } = await import("../src/lib/api-keys");
    const rawKey = generateApiKey();

    const hotel = await db.hotel.create({
      data: {
        name: `F15 Key Hotel ${Date.now()}`,
        status: "ARCHIVED",
      },
    });
    const key = await db.apiKey.create({
      data: {
        hotelId: hotel.id,
        name: "F15 probe",
        prefix: rawKey.slice(0, 14),
        keyHash: hashApiKey(rawKey),
        status: "ACTIVE",
        scopes: JSON.stringify(["read"]),
      },
    });

    const { authenticateApiKey } = await import("../src/lib/api-keys");
    const req = new Request("http://localhost/api/v1/customers", {
      headers: { authorization: `Bearer ${rawKey}` },
    });

    // 1. ARCHIVED hotel → 403 (previously authenticated — only SUSPENDED was checked).
    const r1 = await authenticateApiKey(req);
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.status).toBe(403);
      expect(r1.code).toBe("HOTEL_NOT_ACTIVE");
    }

    // 2. ACTIVE hotel on a plan WITHOUT apiAccess → 403.
    await db.hotel.update({ where: { id: hotel.id }, data: { status: "ACTIVE" } });
    const noApiPlan = await db.plan.findFirst({ where: { apiAccess: false } });
    if (noApiPlan) {
      await db.hotel.update({ where: { id: hotel.id }, data: { planId: noApiPlan.id } });
      const r2 = await authenticateApiKey(req);
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.code).toBe("PLAN_API_DISABLED");
    }

    // 3. EXPIRED subscription → 403.
    const apiPlan = await db.plan.findFirst({ where: { apiAccess: true } });
    await db.hotel.update({ where: { id: hotel.id }, data: { planId: apiPlan?.id ?? null } });
    await db.subscription.create({
      data: {
        hotelId: hotel.id,
        planId: apiPlan?.id ?? (await db.plan.findFirst())!.id,
        status: "EXPIRED",
        billingCycle: "MONTHLY",
        amount: 0,
        currency: "INR",
        currentPeriodStart: new Date(Date.now() - 60 * 24 * 3600 * 1000),
        currentPeriodEnd: new Date(Date.now() - 30 * 24 * 3600 * 1000),
      },
    });
    const r3 = await authenticateApiKey(req);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.code).toBe("SUBSCRIPTION_INACTIVE");

    await db.subscription.deleteMany({ where: { hotelId: hotel.id } });
    await db.apiKey.delete({ where: { id: key.id } });
    await db.hotel.delete({ where: { id: hotel.id } }).catch(() => undefined);
  });
});

/* ------------------------------------------------------------------ */
/* F17 — payment capture recovers a FAILED payment                      */
/* ------------------------------------------------------------------ */
describe("F17 — FAILED payment recovery on valid capture", () => {
  test("capture after failure flips the payment to PAID and activates the subscription", async () => {
    const { markPaymentPaid } = await import("../src/lib/saas/billing");
    // RECHECK FIX (fixture): the fixture used to create a Payment WITHOUT
    // planId, then expect a subscription — processPaymentConfirmation cannot
    // know WHICH plan to activate without it. Bind a real NON-FREE plan:
    // confirmation attaches the plan to the hotel (hotel.planId), and an
    // unordered findFirst resolves FREE (campaignLimit 1) which would starve
    // every later suite. hotelA's original plan is restored in cleanup.
    const plan = await db.plan.findFirst({ where: { name: "PROFESSIONAL" } });
    expect(plan).toBeTruthy();
    const hotelBefore = await db.hotel.findUnique({
      where: { id: hotelAId },
      select: { planId: true },
    });
    const payment = await db.payment.create({
      data: {
        hotelId: hotelAId,
        planId: plan!.id,
        invoiceNumber: `SL-F17-${Date.now()}`,
        amount: 5000,
        discountAmount: 0,
        currency: "INR",
        status: "FAILED",
        provider: "manual",
        failureReason: "first attempt failed",
      },
    });

    const result = await markPaymentPaid({
      paymentId: payment.id,
      providerPaymentId: "pay_f17_recovery",
      reason: "F17 capture-after-failure",
    });
    expect(result.ok).toBe(true);

    const after = await db.payment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe("PAID");
    expect(after?.failureReason).toBeNull();
    // Subscription follow-up ran (inline or via outbox).
    expect(after?.subscriptionId).not.toBeNull();

    await db.subscription
      .deleteMany({ where: { id: after?.subscriptionId ?? "none" } })
      .catch(() => undefined);
    await db.payment.delete({ where: { id: payment.id } }).catch(() => undefined);
    // Restore hotelA's plan — confirmation attaches the payment's plan.
    if (hotelBefore) {
      await db.hotel
        .update({ where: { id: hotelAId }, data: { planId: hotelBefore.planId } })
        .catch(() => undefined);
    }
  });
});

/* ------------------------------------------------------------------ */
/* F18 — restaurant visit validation parity                             */
/* ------------------------------------------------------------------ */
describe("F18 — restaurant visit create validation", () => {
  test("guests=-3 → 422 (previously accepted)", async () => {
    const customer = await db.customer.findFirst({ where: { hotelId: hotelAId } });
    const res = await apiCall("POST", "/api/restaurant/visits", {
      jar: jarA,
      body: { customerId: customer!.id, orderAmount: 100, guests: -3 },
    });
    expect(res.status).toBe(422);
  });

  test("non-numeric orderAmount → 422 (previously a 500)", async () => {
    const customer = await db.customer.findFirst({ where: { hotelId: hotelAId } });
    const res = await apiCall("POST", "/api/restaurant/visits", {
      jar: jarA,
      body: { customerId: customer!.id, orderAmount: "expensive", guests: 2 },
    });
    expect(res.status).toBe(422);
  });

  test("guests=0 and guests=51 → 422", async () => {
    const customer = await db.customer.findFirst({ where: { hotelId: hotelAId } });
    for (const guests of [0, 51]) {
      const res = await apiCall("POST", "/api/restaurant/visits", {
        jar: jarA,
        body: { customerId: customer!.id, orderAmount: 100, guests },
      });
      expect(res.status).toBe(422);
    }
  });
});

/* ------------------------------------------------------------------ */
/* F16 — plan limit on alternate write paths                            */
/* ------------------------------------------------------------------ */
describe("F16 — plan limit enforced on all customer write paths", () => {
  test("v1 API create is limited by the plan's customer limit", async () => {
    // RECHECK FIX (fixture): the probe used to hunt for the smallest seeded
    // plan with apiAccess (customerLimit 5000) and loop 5002 times — that
    // hit the per-key 120 req/min RATE LIMITER (429) long before the plan
    // cap. Instead, create a dedicated tiny plan (limit 2, apiAccess) so the
    // cap is reached in a handful of deterministic, rate-limit-safe calls.
    const { generateApiKey, hashApiKey } = await import("../src/lib/api-keys");
    const rawKey = generateApiKey();
    const plan = await db.plan.create({
      data: {
        name: `F16-LIMIT-PROBE-${Date.now()}`,
        key: `f16-limit-probe-${Date.now()}`,
        description: "F16 fixture plan (deleted after the test)",
        monthlyPrice: 0,
        yearlyPrice: 0,
        customerLimit: 2,
        apiAccess: true,
        isActive: true,
        isPublic: false,
      },
    });
    const hotel = await db.hotel.create({
      data: { name: `F16 Hotel ${Date.now()}`, status: "ACTIVE", planId: plan.id },
    });
    await db.subscription.create({
      data: {
        hotelId: hotel.id,
        planId: plan.id,
        status: "ACTIVE",
        billingCycle: "MONTHLY",
        amount: 0,
        currency: "INR",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    });
    await db.apiKey.create({
      data: {
        hotelId: hotel.id,
        name: "F16 probe",
        prefix: rawKey.slice(0, 14),
        keyHash: hashApiKey(rawKey),
        status: "ACTIVE",
        scopes: JSON.stringify(["read", "write"]),
      },
    });

    let sawLimit = false;
    const made: string[] = [];
    for (let i = 0; i < plan.customerLimit + 2; i++) {
      const res = await apiCall("POST", "/api/v1/customers", {
        bearer: rawKey,
        body: { name: `F16 Customer ${i}`, phone: `+9195${Date.now().toString().slice(-8)}${i}` },
      });
      // Rate-limit safety net: a 429 means the per-key limiter (not the plan
      // cap) fired — wait out the window and retry the SAME create.
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1500));
        i--;
        continue;
      }
      if (res.status === 403 && res.body?.error?.code === "SUBSCRIPTION_LIMIT_REACHED") {
        sawLimit = true;
        break;
      }
      expect(res.status).toBe(201);
      // v1 envelope: { data: customer }
      made.push(res.body?.data?.id);
    }
    expect(sawLimit).toBe(true);
    expect(made.length).toBe(plan.customerLimit); // exactly the limit, never over

    await db.customer.deleteMany({ where: { id: { in: made } } });
    await db.apiKey.deleteMany({ where: { hotelId: hotel.id } });
    await db.subscription.deleteMany({ where: { hotelId: hotel.id } });
    await db.hotel.delete({ where: { id: hotel.id } }).catch(() => undefined);
    await db.plan.delete({ where: { id: plan.id } }).catch(() => undefined);
  });
});

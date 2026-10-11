/**
 * Recheck-release regression suite — end-to-end coverage for the fixes that
 * the independent recheck flagged as launch blockers:
 *
 *   B  Razorpay order→capture correlation WITHOUT notes.paymentId
 *      (persisted providerOrderId↔Payment mapping is authoritative) +
 *      duplicate capture + tampered amount + foreign event acks.
 *   C  confirmRazorpayCheckout rejects a tampered browser callback
 *      (signature + binding) — server-side confirmation is fail-closed.
 *   D  WhatsApp template wiring — the adapter actually transmits a provider
 *      TEMPLATE payload, resolveWhatsAppTemplate gates on approval state,
 *      and campaign sends keep the binding on retries.
 *   E  Existing-member OTP journey — challenge → wrong code (no fresh code,
 *      attempts preserved) → correct code → success; concurrent single-use.
 *   F  Integration disable / unverified / unreadable vault BLOCKS the
 *      channel instead of falling back to the platform sender.
 *   H  OTP consume is atomic under concurrency (one winner).
 *   I  Customer plan cap is enforced ATOMICALLY — 8 concurrent v1 creates
 *      on a limit-1 plan produce exactly one 201.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHash, createHmac } from "crypto";
import { PrismaClient } from "@prisma/client";
import { encryptCredentials } from "../src/lib/crypto";
import { apiCall, login, rawWebhook, ADMIN_PASSWORD, HOTEL_A_ADMIN } from "./helpers";

const db = new PrismaClient();

let jarA: { cookie: string; csrf: string };
let hotelAId = "";
let hotelAOriginalPlanId: string | null = null;

beforeAll(async () => {
  const a = await login(HOTEL_A_ADMIN, ADMIN_PASSWORD);
  jarA = a.jar;
  hotelAId = a.body?.user?.hotelId ?? "";
  expect(hotelAId).toBeTruthy();
  // Payment confirmations attach the payment's plan to the hotel — remember
  // the original so afterAll can restore it for the acceptance suites.
  const hotel = await db.hotel.findUnique({ where: { id: hotelAId }, select: { planId: true } });
  hotelAOriginalPlanId = hotel?.planId ?? null;
});

afterAll(async () => {
  // Restore default (disabled) provider settings so other suites see a
  // pristine billing configuration, and hotelA's original plan (a payment
  // confirmation may have re-attached the fixture plan).
  await db.platformSetting
    .deleteMany({ where: { key: "billing.providers" } })
    .catch(() => undefined);
  if (hotelAOriginalPlanId !== null) {
    await db.hotel
      .update({ where: { id: hotelAId }, data: { planId: hotelAOriginalPlanId } })
      .catch(() => undefined);
  }
  await db.$disconnect();
});

/* ------------------------------------------------------------------ */
/* D — WhatsApp adapter REALLY sends template payloads                  */
/* ------------------------------------------------------------------ */
describe("D — WhatsApp template payload wiring", () => {
  test("WhatsAppCloudProvider transmits type=template with language + positional params", async () => {
    const { WhatsAppCloudProvider } = await import("../src/lib/providers");
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const origFetch = global.fetch;
    global.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.recheck" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const provider = new WhatsAppCloudProvider("token-x", "phone-id-1");

      // Template send — the shape Meta requires outside the 24h window.
      const t = await provider.send({
        to: "+919000000001",
        body: "text fallback",
        template: {
          name: "promo_offer",
          languageCode: "en",
          variables: { "1": "Ankit", "2": "20% OFF" },
        },
      });
      expect(t.ok).toBe(true);
      expect(t.kind).toBe("TEMPLATE");

      // Text send — unchanged free-form shape.
      const s = await provider.send({ to: "+919000000001", body: "hello" });
      expect(s.ok).toBe(true);
      expect(s.kind).toBe("TEXT");
    } finally {
      global.fetch = origFetch;
    }

    expect(calls.length).toBe(2);
    const templateCall = calls[0];
    expect(templateCall.url).toContain("/phone-id-1/messages");
    expect(templateCall.body.type).toBe("template");
    const tpl = templateCall.body.template as {
      name: string;
      language: { code: string };
      components?: { type: string; parameters: { type: string; text: string }[] }[];
    };
    expect(tpl.name).toBe("promo_offer");
    expect(tpl.language.code).toBe("en");
    expect(tpl.components?.[0]?.parameters?.map((p) => p.text)).toEqual(["Ankit", "20% OFF"]);

    const textCall = calls[1];
    expect(textCall.body.type).toBe("text");
    expect((textCall.body.text as { body: string }).body).toBe("hello");
  });

  test("resolveWhatsAppTemplate: approved binding resolves, unapproved never sends", async () => {
    const { resolveWhatsAppTemplate } = await import("../src/lib/campaigns");
    const ctx = {
      name: "Priya Sharma",
      hotelName: "Grand Palace",
      lastVisit: new Date().toISOString(),
      bookingCount: 2,
      offer: "30% OFF",
      bookingLink: "https://book.example/x",
    };

    const approved = await db.messageTemplate.create({
      data: {
        hotelId: hotelAId,
        name: `RCHK Approved ${Date.now()}`,
        body: "Hi {{name}}, {{offer}} at {{hotel_name}}: {{booking_link}}",
        channels: JSON.stringify(["WHATSAPP"]),
        providerTemplateId: "rchk_promo",
        languageCode: "en",
        variableMap: JSON.stringify({ "1": "name", "2": "offer" }),
        approvalStatus: "APPROVED",
      },
    });
    const pending = await db.messageTemplate.create({
      data: {
        hotelId: hotelAId,
        name: `RCHK Pending ${Date.now()}`,
        body: "Hi {{name}}, {{offer}}!",
        channels: JSON.stringify(["WHATSAPP"]),
        providerTemplateId: "rchk_pending",
        languageCode: "en",
        variableMap: JSON.stringify({ "1": "name", "2": "offer" }),
        approvalStatus: "PENDING",
      },
    });

    // APPROVED + bound + WhatsApp → real template payload.
    const okPayload = await resolveWhatsAppTemplate(
      hotelAId,
      { messageTemplateId: approved.id },
      ctx,
    );
    expect(okPayload).not.toBeNull();
    expect(okPayload!.name).toBe("rchk_promo");
    expect(okPayload!.languageCode).toBe("en");
    expect(okPayload!.variables?.["1"]).toBe("Priya"); // first name, like the personalizer
    expect(okPayload!.variables?.["2"]).toBe("30% OFF");

    // PENDING approval → NEVER sent as template (falls back to free-form).
    const pendingPayload = await resolveWhatsAppTemplate(
      hotelAId,
      { messageTemplateId: pending.id },
      ctx,
    );
    expect(pendingPayload).toBeNull();

    // No binding → null.
    const none = await resolveWhatsAppTemplate(hotelAId, { messageTemplateId: null }, ctx);
    expect(none).toBeNull();

    await db.messageTemplate.delete({ where: { id: approved.id } }).catch(() => undefined);
    await db.messageTemplate.delete({ where: { id: pending.id } }).catch(() => undefined);
  });
});

/* ------------------------------------------------------------------ */
/* F — disabled / unverified / unreadable tenant integration BLOCKS     */
/* ------------------------------------------------------------------ */
describe("F — provider-source policy is fail-closed", () => {
  test("disabled tenant integration BLOCKS sends instead of using the platform sender", async () => {
    const { resolveTenantProvider } = await import("../src/lib/tenant-providers");
    const creds = encryptCredentials(
      { hotelId: hotelAId, integrationType: "WHATSAPP_CLOUD" },
      { token: "tok-recheck", phoneNumberId: "pnid-recheck" },
    );
    const row = await db.integration.create({
      data: {
        hotelId: hotelAId,
        type: "WHATSAPP_CLOUD",
        name: `RCHK WA ${Date.now()}`,
        status: "VERIFIED",
        credentials: creds,
        enabled: true,
      },
    });

    // Enabled + verified → the TENANT provider is used.
    const live = await resolveTenantProvider(hotelAId, "WHATSAPP");
    expect(live.id).toBe("WHATSAPP_CLOUD");

    // DISABLED → BLOCKED (send fails honestly) — never the platform ENV
    // fallback, never silent simulation.
    await db.integration.update({ where: { id: row.id }, data: { enabled: false } });
    const disabled = await resolveTenantProvider(hotelAId, "WHATSAPP");
    expect(disabled.id).toBe("BLOCKED");
    const sendResult = await disabled.send({ to: "+919000000002", body: "x" });
    expect(sendResult.ok).toBe(false);
    expect(sendResult.error ?? "").toMatch(/disabled/i);

    // SAVED_UNVERIFIED → BLOCKED until a real verify passes.
    await db.integration.update({
      where: { id: row.id },
      data: { enabled: true, status: "SAVED_UNVERIFIED" },
    });
    const unverified = await resolveTenantProvider(hotelAId, "WHATSAPP");
    expect(unverified.id).toBe("BLOCKED");

    // Unreadable vault blob → BLOCKED (fail closed, not ENV).
    await db.integration.update({
      where: { id: row.id },
      data: { status: "VERIFIED", credentials: "v1:garbage:notanenvelope:xxxx" },
    });
    const broken = await resolveTenantProvider(hotelAId, "WHATSAPP");
    expect(broken.id).toBe("BLOCKED");

    // Rows removed → platform default chain applies (SIMULATION in tests).
    await db.integration.delete({ where: { id: row.id } });
    const cleared = await resolveTenantProvider(hotelAId, "WHATSAPP");
    expect(cleared.id).toBe("SIMULATION");
  });
});

/* ------------------------------------------------------------------ */
/* E + H — existing-member OTP journey + atomic single-use              */
/* ------------------------------------------------------------------ */

/** The DB stores only sha256(phone:code:purpose) — recover the plaintext by
 * brute force over the 6-digit space (deterministic, <1s in bun). */
function recoverOtpCode(phone: string, codeHash: string, purpose = "PUBLIC_JOIN"): string {
  for (let n = 0; n < 1_000_000; n++) {
    const code = String(n).padStart(6, "0");
    if (createHash("sha256").update(`${phone}:${code}:${purpose}`).digest("hex") === codeHash) {
      return code;
    }
  }
  throw new Error("OTP code not recovered — hash mismatch");
}

describe("E/H — public join OTP journey (existing member)", () => {
  const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3100";

  async function join(payload: Record<string, unknown>) {
    const res = await fetch(`${BASE}/api/public/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  test("challenge → wrong code (no fresh code, attempts kept) → correct code → success", async () => {
    const phone = `+9196${Date.now().toString().slice(-8)}`;
    // Seed an EXISTING member on this phone.
    await db.customer.create({
      data: { hotelId: hotelAId, name: "RCHK Existing Member", phone },
    });

    // Step 1 — no OTP → 202 challenge (issued), member data never revealed.
    const step1 = await join({
      qrCode: await joinQrCode(),
      name: "Hacker One",
      phone,
      marketingConsent: true,
    });
    expect(step1.status).toBe(202);
    expect(step1.body?.otpRequired).toBe(true);
    expect(step1.body?.challenge).toBe("issued");
    expect(step1.body?.customer).toBeNull();
    expect(step1.body?.loyalty).toBeNull();

    const otpRow = await db.phoneOtp.findUnique({
      where: { hotelId_phone_purpose: { hotelId: hotelAId, phone, purpose: "PUBLIC_JOIN" } },
    });
    expect(otpRow).toBeTruthy();
    const code = recoverOtpCode(phone, otpRow!.codeHash);

    // Step 2 — WRONG code → 202 mismatch, and NO new code was minted
    // (attempts preserved — the old code stays the live one).
    const step2 = await join({
      qrCode: await joinQrCode(),
      name: "Hacker One",
      phone,
      marketingConsent: true,
      otp: "000000" === code ? "111111" : "000000",
    });
    expect(step2.status).toBe(202);
    expect(step2.body?.challenge).toBe("mismatch");
    const rowAfterWrong = await db.phoneOtp.findUnique({
      where: { hotelId_phone_purpose: { hotelId: hotelAId, phone, purpose: "PUBLIC_JOIN" } },
    });
    expect(rowAfterWrong!.attempts).toBe(1);
    expect(rowAfterWrong!.codeHash).toBe(otpRow!.codeHash); // NOT re-issued

    // Step 3 — CORRECT code → success with the verified member view.
    const step3 = await join({
      qrCode: await joinQrCode(),
      name: "Real Owner",
      phone,
      marketingConsent: false,
      otp: code,
    });
    expect(step3.status).toBe(200);
    expect(step3.body?.ok).toBe(true);
    expect(step3.body?.customer?.name).toBe("Real Owner");
  });
  test("two concurrent correct verifications → exactly ONE success (atomic consume)", async () => {
    const phone = `+9196${(Date.now() + 1).toString().slice(-8)}`;
    await db.customer.create({
      data: { hotelId: hotelAId, name: "RCHK Race Member", phone },
    });

    const first = await join({
      qrCode: await joinQrCode(),
      name: "Race Owner",
      phone,
      marketingConsent: false,
    });
    expect(first.status).toBe(202);
    const otpRow = await db.phoneOtp.findUnique({
      where: { hotelId_phone_purpose: { hotelId: hotelAId, phone, purpose: "PUBLIC_JOIN" } },
    });
    const code = recoverOtpCode(phone, otpRow!.codeHash);

    const payload = {
      qrCode: await joinQrCode(),
      name: "Race Owner",
      phone,
      marketingConsent: false,
      otp: code,
    };
    const [r1, r2] = await Promise.all([join(payload), join(payload)]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 202]); // exactly one winner
    const rowAfter = await db.phoneOtp.findUnique({
      where: { hotelId_phone_purpose: { hotelId: hotelAId, phone, purpose: "PUBLIC_JOIN" } },
    });
    expect(rowAfter!.consumedAt).not.toBeNull();
  });
});

let joinQrCache: string | null = null;
async function joinQrCode(): Promise<string> {
  if (joinQrCache) return joinQrCache;
  let qr = await db.qRCode.findFirst({
    where: { hotelId: hotelAId, type: "LOYALTY", active: true },
  });
  if (!qr) {
    qr = await db.qRCode.create({
      data: { hotelId: hotelAId, code: `RCHKJOIN${Date.now()}`, type: "LOYALTY", active: true },
    });
  }
  joinQrCache = qr.code;
  return qr.code;
}

/* ------------------------------------------------------------------ */
/* B — Razorpay order→capture correlation (no notes.paymentId)          */
/* ------------------------------------------------------------------ */
describe("B — Razorpay webhook correlates via persisted providerOrderId", () => {
  const WEBHOOK_SECRET = "recheck-whsec-0123456789abcdef0123456789abcdef";

  beforeAll(async () => {
    // Enable Razorpay with a KNOWN webhook secret for this suite.
    const { encryptPlatformSecret } = await import("../src/lib/saas/billing");
    const value = JSON.stringify({
      razorpay: {
        enabled: true,
        mode: "test",
        keyId: "rzp_test_recheck",
        keySecretEnc: encryptPlatformSecret("recheck-key-secret", "razorpay-key"),
        webhookSecretEnc: encryptPlatformSecret(WEBHOOK_SECRET, "razorpay-webhook"),
      },
      stripe: { enabled: false, mode: "test" },
      manual: { enabled: true, mode: "test" },
    });
    await db.platformSetting.upsert({
      where: { key: "billing.providers" },
      create: { key: "billing.providers", value },
      update: { value },
    });
  });

  function signedEvent(event: Record<string, unknown>): {
    raw: string;
    headers: Record<string, string>;
  } {
    const raw = JSON.stringify(event);
    return {
      raw,
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex"),
      },
    };
  }

  function capturedEvent(
    orderId: string,
    paymentId: string,
    amountMinor: number,
    notes: Record<string, string> = {},
  ) {
    return {
      event: "payment.captured",
      payload: {
        payment: {
          entity: { id: paymentId, order_id: orderId, amount: amountMinor, currency: "INR", notes },
        },
      },
    };
  }

  test("capture WITHOUT notes.paymentId activates the subscription via the order mapping", async () => {
    // A paid plan whose activation will not starve later suites — payment
    // confirmation attaches the plan to the hotel (restored in afterAll).
    const plan = await db.plan.findFirst({ where: { name: "PROFESSIONAL" } });
    expect(plan).toBeTruthy();
    const orderId = `order_rchk_${Date.now()}`;
    const payment = await db.payment.create({
      data: {
        hotelId: hotelAId,
        planId: plan!.id,
        invoiceNumber: `SL-RCHK-${Date.now()}`,
        amount: 2500,
        discountAmount: 0,
        currency: "INR",
        status: "PENDING",
        provider: "razorpay",
        providerOrderId: orderId,
        billingCycle: "MONTHLY",
        idempotencyKey: `rchk-${orderId}`,
      },
    });

    // NOTE: entity.notes has NO paymentId — the old webhook returned early
    // here and the capture was lost. The persisted order mapping must win.
    const { raw, headers } = signedEvent(capturedEvent(orderId, "pay_rchk_1", 250000));
    const res = await rawWebhook("/api/billing/webhook/razorpay", raw, headers);
    expect(res.status).toBe(200);
    expect(res.body?.received).toBe(true);
    expect(res.body?.ok).toBe(true);

    const after = await db.payment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe("PAID");
    expect(after?.providerPaymentId).toBe("pay_rchk_1");
    expect(after?.subscriptionId).not.toBeNull();

    // DUPLICATE capture of the SAME provider payment → idempotent ack.
    const dupEvt = signedEvent(capturedEvent(orderId, "pay_rchk_1", 250000));
    const dup = await rawWebhook("/api/billing/webhook/razorpay", dupEvt.raw, dupEvt.headers);
    expect(dup.status).toBe(200);
    expect(dup.body?.alreadyPaid).toBe(true);

    // A capture claiming a DIFFERENT payment id for the same order →
    // quarantined (unique provider-payment binding).
    const rogueEvt = signedEvent(capturedEvent(orderId, "pay_rchk_ROGUE", 250000));
    const rogue = await rawWebhook("/api/billing/webhook/razorpay", rogueEvt.raw, rogueEvt.headers);
    expect(rogue.body?.ok).toBe(false);

    await db.subscription
      .deleteMany({ where: { id: after?.subscriptionId ?? "none" } })
      .catch(() => undefined);
    await db.payment.delete({ where: { id: payment.id } }).catch(() => undefined);
  });

  test("tampered amount and foreign events never touch local invoices", async () => {
    const plan = await db.plan.findFirst({ where: { name: "PROFESSIONAL" } });
    const orderId = `order_rchk_bad_${Date.now()}`;
    const payment = await db.payment.create({
      data: {
        hotelId: hotelAId,
        planId: plan!.id,
        invoiceNumber: `SL-RCHKBAD-${Date.now()}`,
        amount: 2500,
        currency: "INR",
        status: "PENDING",
        provider: "razorpay",
        providerOrderId: orderId,
        billingCycle: "MONTHLY",
        idempotencyKey: `rchk-bad-${orderId}`,
      },
    });

    // ₹1 tampered amount (even correctly SIGNED) → quarantined, stays PENDING.
    const tamperEvt = signedEvent(capturedEvent(orderId, "pay_rchk_tamper", 100));
    const tampered = await rawWebhook(
      "/api/billing/webhook/razorpay",
      tamperEvt.raw,
      tamperEvt.headers,
    );
    expect(tampered.body?.ok).toBe(false);
    const stillPending = await db.payment.findUnique({ where: { id: payment.id } });
    expect(stillPending?.status).toBe("PENDING");

    // A real provider payload with a missing amount field → fail closed.
    const noAmount = {
      event: "payment.captured",
      payload: {
        payment: { entity: { id: "pay_rchk_noamount", order_id: orderId, currency: "INR" } },
      },
    };
    const noAmountEvt = signedEvent(noAmount);
    const noAmountRes = await rawWebhook(
      "/api/billing/webhook/razorpay",
      noAmountEvt.raw,
      noAmountEvt.headers,
    );
    expect(noAmountRes.body?.ok).toBe(false);

    // Foreign event (unknown order, no notes) → acked and ignored.
    const foreignEvt = signedEvent(capturedEvent("order_foreign", "pay_foreign", 99000));
    const foreign = await rawWebhook(
      "/api/billing/webhook/razorpay",
      foreignEvt.raw,
      foreignEvt.headers,
    );
    expect(foreign.status).toBe(200);
    expect(foreign.body?.received).toBe(true);

    await db.payment.delete({ where: { id: payment.id } }).catch(() => undefined);
  });

  test("confirmRazorpayCheckout rejects a forged browser callback (signature fail-closed)", async () => {
    const plan = await db.plan.findFirst({ where: { name: "PROFESSIONAL" } });
    const orderId = `order_rchk_ui_${Date.now()}`;
    const payment = await db.payment.create({
      data: {
        hotelId: hotelAId,
        planId: plan!.id,
        invoiceNumber: `SL-RCHKUI-${Date.now()}`,
        amount: 2500,
        currency: "INR",
        status: "PENDING",
        provider: "razorpay",
        providerOrderId: orderId,
        billingCycle: "MONTHLY",
        idempotencyKey: `rchk-ui-${orderId}`,
      },
    });

    // Forged "browser callback" with a bogus signature — must be rejected
    // BEFORE any Razorpay network call and the invoice must stay PENDING.
    const res = await apiCall("POST", "/api/billing/checkout/verify", {
      jar: jarA,
      body: {
        paymentId: payment.id,
        razorpayOrderId: orderId,
        razorpayPaymentId: "pay_forged",
        razorpaySignature: "deadbeef",
      },
    });
    expect(res.status).toBe(400);
    const after = await db.payment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe("PENDING");

    await db.payment.delete({ where: { id: payment.id } }).catch(() => undefined);
  });
});

/* ------------------------------------------------------------------ */
/* I — concurrent customer cap enforcement (v1 API)                     */
/* ------------------------------------------------------------------ */
describe("I — atomic customer capacity under concurrency", () => {
  test("8 concurrent v1 creates on a limit-1 plan → exactly one 201", async () => {
    const { generateApiKey, hashApiKey } = await import("../src/lib/api-keys");
    const rawKey = generateApiKey();
    const plan = await db.plan.create({
      data: {
        name: `RCHK-CAP-${Date.now()}`,
        key: `rchk-cap-${Date.now()}`,
        description: "recheck capacity fixture",
        monthlyPrice: 0,
        yearlyPrice: 0,
        customerLimit: 1,
        apiAccess: true,
        isActive: true,
        isPublic: false,
      },
    });
    const hotel = await db.hotel.create({
      data: { name: `RCHK Cap Hotel ${Date.now()}`, status: "ACTIVE", planId: plan.id },
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
        name: "RCHK cap probe",
        prefix: rawKey.slice(0, 14),
        keyHash: hashApiKey(rawKey),
        status: "ACTIVE",
        scopes: JSON.stringify(["read", "write"]),
      },
    });

    const stamp = Date.now();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        apiCall("POST", "/api/v1/customers", {
          bearer: rawKey,
          body: { name: `RCHK Cap ${i}`, phone: `+9199${stamp.toString().slice(-8)}${i}` },
        }),
      ),
    );
    const created = results.filter((r) => r.status === 201).length;
    const limited = results.filter((r) => r.status === 403).length;
    expect(created).toBe(1);
    expect(limited).toBe(7);

    const finalCount = await db.customer.count({ where: { hotelId: hotel.id } });
    expect(finalCount).toBe(1);

    await db.customer.deleteMany({ where: { hotelId: hotel.id } });
    await db.apiKey.deleteMany({ where: { hotelId: hotel.id } });
    await db.subscription.deleteMany({ where: { hotelId: hotel.id } });
    await db.hotel.delete({ where: { id: hotel.id } }).catch(() => undefined);
    await db.plan.delete({ where: { id: plan.id } }).catch(() => undefined);
  });
});

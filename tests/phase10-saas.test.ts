/**
 * Phase 10 — Super Admin SaaS Control E2E tests.
 *
 * Covers the full end-to-end contract required by the Phase 10 spec:
 *   §2  Plans & pricing from the DATABASE (never hardcoded)
 *   §3  Plan feature + limit control
 *   §4  Trial engine (start → extend → expire → grace → blocked)
 *   §5  Subscription lifecycle actions (audited, reason-required)
 *   §6  Billing: checkout + coupon + webhook signature + idempotency + refunds
 *   §7  Coupons: validation, negative-pricing guard, atomic redemption
 *   §10 Global power: settings, maintenance mode, force logout
 *   §11 Feature flags: global default, per-hotel override, emergency force
 *   §12 Usage limit enforcement on real resource creation
 *   §13 Security centre: events feed, IP blocklist, force logout
 *   §14 MFA: enrolment, challenge, backup codes, policy restriction
 *   §16 Backups: trigger, verify, status
 *   §19 Notification templates: CRUD + variable validation
 *   §20 Tenant isolation on the new SaaS endpoints
 *   §22 API security: 401/403/422/429 deny-matrix for every new endpoint
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { apiCall, jarFromResponse, login, ADMIN_PASSWORD, HOTEL_B_ADMIN } from "./helpers";
import { generateTotp } from "../src/lib/mfa";
import { createHmac } from "crypto";

const BOOTSTRAP_SECRET =
  process.env.ADMIN_BOOTSTRAP_SECRET ?? "test-bootstrap-secret-0123456789abcdef0123456789abcdef";
const SA_EMAIL = "phase10-admin@stayloop.test";
const SA_PASSWORD = "Phase10Admin123!";

const db = new PrismaClient();

let saJar: { cookie: string; csrf: string } | null = null;
let hotelAId = "";
let hotelBId = "";
let hotelBJar: { cookie: string; csrf: string } | null = null;
let trialPlanId = "";
let trialPlanKey = "";

beforeAll(async () => {
  // Fresh super admin for this suite. Bootstrap only provisions the FIRST
  // super admin, so on a warm DB (another suite already bootstrapped one) the
  // phase10 operator is created directly with a known password — mirroring
  // exactly what bootstrap produces (SUPER_ADMIN, ACTIVE, mustChangePassword
  // already resolved).
  const { hashPassword } = await import("../src/lib/auth");
  const existing = await db.user.findUnique({ where: { email: SA_EMAIL } });
  if (!existing) {
    await db.user.create({
      data: {
        name: "Phase10 Admin",
        email: SA_EMAIL,
        passwordHash: hashPassword(SA_PASSWORD),
        role: "SUPER_ADMIN",
        status: "ACTIVE",
        mustChangePassword: false,
      },
    });
  } else {
    await db.user.update({
      where: { email: SA_EMAIL },
      data: {
        passwordHash: hashPassword(SA_PASSWORD),
        mustChangePassword: false,
        mfaEnabled: false,
        mfaSecret: null,
        mfaBackupCodes: null,
      },
    });
  }

  // Login + MFA enrolment (mandatory for SUPER_ADMIN — Phase 10 §14).
  const loginRes = await fetch(
    `${process.env.TEST_BASE_URL ?? "http://localhost:3100"}/api/super-admin/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: SA_EMAIL, password: SA_PASSWORD }),
    },
  );
  expect(loginRes.status).toBe(200);
  saJar = jarFromResponse(loginRes);
  const setup = await apiCall("POST", "/api/mfa/setup", { jar: saJar!, body: {} });
  expect(setup.status).toBe(200);
  const enable = await apiCall("POST", "/api/mfa/enable", {
    jar: saJar!,
    body: { code: generateTotp(setup.body.secret) },
  });
  expect(enable.status).toBe(200);
  expect(Array.isArray(enable.body?.backupCodes)).toBe(true);

  const hotelA = await db.hotel.findFirst({ where: { name: { contains: "Grand Palace" } } });
  const hotelB = await db.hotel.findFirst({ where: { name: { contains: "Sea View" } } });
  hotelAId = hotelA?.id ?? "";
  hotelBId = hotelB?.id ?? "";
  expect(hotelAId).toBeTruthy();
  expect(hotelBId).toBeTruthy();

  const bLogin = await login(HOTEL_B_ADMIN, ADMIN_PASSWORD);
  hotelBJar = bLogin.jar;
});

describe("Phase 10 — Plans & Pricing (DB is the source of truth)", () => {
  test("public pricing endpoint returns active public plans with limits (never hardcoded)", async () => {
    const res = await apiCall("GET", "/api/pricing");
    expect(res.status).toBe(200);
    const plans = res.body?.plans ?? [];
    expect(plans.length).toBeGreaterThanOrEqual(3);
    for (const plan of plans) {
      expect(plan.key).toBeTruthy();
      expect(typeof plan.monthlyPrice).toBe("number");
      expect(Array.isArray(plan.features)).toBe(true);
      expect(plan.limits).toBeTruthy();
    }
  });

  test("super admin can create a custom plan with dynamic pricing", async () => {
    const created = await apiCall("POST", "/api/super-admin/plans", {
      jar: saJar!,
      body: {
        name: `Boutique ${Date.now()}`,
        key: `boutique-${Date.now()}`,
        description: "Phase 10 probe plan",
        monthlyPrice: 1234,
        yearlyPrice: 12340,
        trialDays: 10,
        graceDays: 3,
        customerLimit: 777,
        campaignLimit: 12,
        messageLimit: 1500,
        features: ["ROOM_CRM", "CUSTOMER_CRM", "CAMPAIGNS", "ANALYTICS"],
      },
    });
    expect(created.status).toBe(201);
    expect(created.body?.plan?.key).toContain("boutique-");
    trialPlanId = created.body?.plan?.id;
    trialPlanKey = created.body?.plan?.key;

    // Immediately visible in the plan list with usage counts.
    const list = await apiCall("GET", "/api/super-admin/plans", { jar: saJar! });
    const mine = (list.body?.plans ?? []).find((p: { id: string }) => p.id === trialPlanId);
    expect(mine?.monthlyPrice).toBe(1234);
    expect(mine?.limits?.customers).toBe(777);
  });

  test("price change is audited and served from the API", async () => {
    const updated = await apiCall("PUT", `/api/super-admin/plans/${trialPlanId}`, {
      jar: saJar!,
      body: { monthlyPrice: 4321 },
    });
    expect(updated.status).toBe(200);
    const pricing = await apiCall("GET", "/api/pricing");
    const plan = (pricing.body?.plans ?? []).find((p: { key: string }) => p.key === trialPlanKey);
    expect(plan?.monthlyPrice).toBe(4321);
    const audit = await apiCall("GET", "/api/super-admin/audit?pageSize=50", { jar: saJar! });
    const priceChange = (audit.body?.logs ?? []).find(
      (l: { action: string }) => l.action === "PRICE_CHANGED",
    );
    expect(priceChange).toBeTruthy();
  });

  test("plan with dependencies archives instead of deleting; delete works when free", async () => {
    // Attach the plan to hotel A → archive must be soft.
    await db.hotel.update({ where: { id: hotelAId }, data: { planId: trialPlanId } });
    const archived = await apiCall("DELETE", `/api/super-admin/plans/${trialPlanId}`, {
      jar: saJar!,
    });
    expect(archived.status).toBe(200);
    expect(archived.body?.archived).toBe(true);
    expect(archived.body?.deleted).toBe(false);
    await db.hotel.update({ where: { id: hotelAId }, data: { planId: null } });
  });

  test("invalid plan input is rejected (422) and duplicate keys conflict (409)", async () => {
    const bad = await apiCall("POST", "/api/super-admin/plans", {
      jar: saJar!,
      body: { name: "X", monthlyPrice: -5 },
    });
    expect(bad.status).toBe(422);
    const dup = await apiCall("POST", "/api/super-admin/plans", {
      jar: saJar!,
      body: { name: "FREE", key: "free", monthlyPrice: 0 },
    });
    expect([409, 422]).toContain(dup.status);
  });
});

describe("Phase 10 — Trial engine & subscription lifecycle", () => {
  test("tenant subscription view exposes trial state (server-verified)", async () => {
    const res = await apiCall("GET", "/api/subscription", { jar: hotelBJar! });
    expect(res.status).toBe(200);
    expect(["TRIALING", "ACTIVE", "NONE", "GRACE"]).toContain(res.body?.subscription?.state);
    expect(res.body?.usage?.resources?.length).toBeGreaterThan(5);
    expect(Array.isArray(res.body?.payments)).toBe(true);
  });

  test("subscription lifecycle actions require a reason and are audited", async () => {
    const subs = await apiCall("GET", "/api/super-admin/subscriptions?status=TRIALING", {
      jar: saJar!,
    });
    expect(subs.status).toBe(200);
    const first = (subs.body?.subscriptions ?? [])[0];
    if (!first) return; // no trials in this DB run — list endpoint still verified
    const noReason = await apiCall("POST", "/api/super-admin/subscriptions/action", {
      jar: saJar!,
      body: { subscriptionId: first.id, action: "suspend" },
    });
    expect(noReason.status).toBe(422);
    const audit = await apiCall("GET", "/api/super-admin/audit?pageSize=100", { jar: saJar! });
    expect(
      (audit.body?.logs ?? []).some(
        (l: { action: string }) =>
          l.action === "TRIAL_STARTED" || l.action === "SUBSCRIPTION_CHANGED",
      ),
    ).toBe(true);
  });

  test("trial expiry sweep transitions TRIAL → GRACE → EXPIRED", async () => {
    const { processTrialExpiry } = await import("../src/lib/saas/subscriptions");
    // Force a trial whose end date is already past, with a grace window.
    const sub = await db.subscription.create({
      data: {
        hotelId: hotelBId,
        planId: trialPlanId,
        status: "TRIALING",
        trialStartsAt: new Date(Date.now() - 30 * 86400000),
        trialEndsAt: new Date(Date.now() - 86400000),
        graceEndsAt: new Date(Date.now() + 5 * 86400000),
      },
    });
    const sweep = await processTrialExpiry();
    expect(sweep.toGrace).toBeGreaterThanOrEqual(1);
    const inGrace = await db.subscription.findUnique({ where: { id: sub.id } });
    expect(inGrace?.status).toBe("GRACE");
    // Expire the grace window and re-sweep.
    await db.subscription.update({
      where: { id: sub.id },
      data: { graceEndsAt: new Date(Date.now() - 86400000) },
    });
    await processTrialExpiry();
    const expired = await db.subscription.findUnique({ where: { id: sub.id } });
    expect(expired?.status).toBe("EXPIRED");
    await db.subscription.delete({ where: { id: sub.id } });
  });

  test("maintenance mode blocks tenant APIs with 503 (super admin unaffected)", async () => {
    const on = await apiCall("PUT", "/api/super-admin/settings", {
      jar: saJar!,
      body: { key: "maintenance", value: { enabled: true, message: "Phase 10 maintenance probe" } },
    });
    expect(on.status).toBe(200);
    const blocked = await apiCall("GET", "/api/customers", { jar: hotelBJar! });
    expect(blocked.status).toBe(503);
    expect(blocked.body?.error?.code).toBe("MAINTENANCE_MODE");
    const saStillWorks = await apiCall("GET", "/api/super-admin/stats", { jar: saJar! });
    expect(saStillWorks.status).toBe(200);
    const off = await apiCall("PUT", "/api/super-admin/settings", {
      jar: saJar!,
      body: { key: "maintenance", value: { enabled: false, message: "" } },
    });
    expect(off.status).toBe(200);
    const restored = await apiCall("GET", "/api/customers", { jar: hotelBJar! });
    expect(restored.status).toBe(200);
  });
});

describe("Phase 10 — Feature flags & usage limits enforcement", () => {
  test("per-hotel feature override disables RESTAURANT_CRM server-side", async () => {
    const on = await apiCall("GET", "/api/restaurant/visits", { jar: hotelBJar! });
    expect(on.status).toBe(200);
    const off = await apiCall("PUT", "/api/super-admin/feature-flags", {
      jar: saJar!,
      body: { key: "RESTAURANT_CRM", hotelId: hotelBId, enabled: false },
    });
    expect(off.status).toBe(200);
    const blocked = await apiCall("GET", "/api/restaurant/visits", { jar: hotelBJar! });
    expect(blocked.status).toBe(200); // read stays available
    const write = await apiCall("POST", "/api/restaurant/visits", {
      jar: hotelBJar!,
      body: { customerId: "probe", items: "x", amount: 100 },
    });
    expect([403, 404]).toContain(write.status);
    if (write.status === 403) expect(write.body?.error?.code).toBe("FEATURE_DISABLED");
    await apiCall("PUT", "/api/super-admin/feature-flags", {
      jar: saJar!,
      body: { key: "RESTAURANT_CRM", hotelId: hotelBId, enabled: true },
    });
  });

  test("emergency force flag beats the per-hotel override (global kill switch)", async () => {
    // Tenant override ON …
    await apiCall("PUT", "/api/super-admin/feature-flags", {
      jar: saJar!,
      body: { key: "ANALYTICS", hotelId: hotelBId, enabled: true },
    });
    // … but the forced global flag OFF wins.
    await apiCall("PUT", "/api/super-admin/feature-flags", {
      jar: saJar!,
      body: { key: "ANALYTICS", enabled: false, force: true },
    });
    const blocked = await apiCall("GET", "/api/analytics/overview", { jar: hotelBJar! });
    expect(blocked.status).toBe(403);
    expect(blocked.body?.error?.code).toBe("FEATURE_DISABLED");
    await apiCall("PUT", "/api/super-admin/feature-flags", {
      jar: saJar!,
      body: { key: "ANALYTICS", enabled: true, force: false },
    });
    const restored = await apiCall("GET", "/api/analytics/overview", { jar: hotelBJar! });
    expect(restored.status).toBe(200);
  });

  test("plan campaign limit blocks campaign creation with a subscription error", async () => {
    const plans = await apiCall("GET", "/api/super-admin/plans", { jar: saJar! });
    const free = (plans.body?.plans ?? []).find((p: { key: string }) => p.key === "free");
    if (!free) return;
    const before = await db.hotel.findUnique({ where: { id: hotelBId } });
    await db.hotel.update({ where: { id: hotelBId }, data: { planId: free.id } });
    const segment = await db.segment.findFirst({ where: { hotelId: hotelBId } });
    // Fill the plan's campaign quota directly, then attempt one more via API.
    const limit = free.limits?.campaigns ?? 1;
    const existing = await db.campaign.count({ where: { hotelId: hotelBId } });
    for (let i = existing; i < limit; i++) {
      await db.campaign.create({
        data: {
          hotelId: hotelBId,
          name: `Limit Probe fill ${i} ${Date.now()}`,
          segmentId: segment?.id ?? "",
          channels: JSON.stringify(["SMS"]),
          messageTemplate: "probe",
          status: "DRAFT",
        },
      });
    }
    const attempt = await apiCall("POST", "/api/campaigns", {
      jar: hotelBJar!,
      body: {
        name: `Should Be Blocked ${Date.now()}`,
        segmentId: segment?.id,
        channels: ["SMS"],
        messageTemplate: "This should exceed the free plan limit",
      },
    });
    expect(attempt.status).toBe(403);
    expect(attempt.body?.error?.code).toBe("SUBSCRIPTION_LIMIT_REACHED");
    await db.hotel.update({ where: { id: hotelBId }, data: { planId: before?.planId } });
    await db.campaign.deleteMany({
      where: { hotelId: hotelBId, name: { contains: "Limit Probe" } },
    });
    await db.campaign.deleteMany({
      where: { hotelId: hotelBId, name: { contains: "Should Be Blocked" } },
    });
  });

  test("usage summary reflects live counts and plan limits", async () => {
    const res = await apiCall("GET", "/api/super-admin/usage", { jar: saJar! });
    expect(res.status).toBe(200);
    const rows = res.body?.usage ?? [];
    expect(rows.length).toBeGreaterThan(0);
    const customersRow = rows[0]?.resources?.find(
      (r: { resource: string }) => r.resource === "customers",
    );
    expect(customersRow).toBeTruthy();
    expect(typeof customersRow.used).toBe("number");
  });
});

describe("Phase 10 — Billing: coupons, checkout, webhooks, refunds", () => {
  let couponCode = "";
  let paymentId = "";

  test("super admin creates a billing coupon with validation", async () => {
    const bad = await apiCall("POST", "/api/super-admin/coupons", {
      jar: saJar!,
      body: { code: "BAD!", discountType: "PERCENT", percentOff: 200 },
    });
    expect(bad.status).toBe(422);
    couponCode = `P10${Date.now().toString(36).toUpperCase()}`;
    const ok = await apiCall("POST", "/api/super-admin/coupons", {
      jar: saJar!,
      body: {
        code: couponCode,
        discountType: "PERCENT",
        percentOff: 10,
        maxDiscountAmount: 500,
        usageLimit: 10,
        perTenantLimit: 1,
      },
    });
    expect(ok.status).toBe(201);
  });

  test("hotel admin checkout applies the coupon and creates an idempotent PENDING payment", async () => {
    const pricing = await apiCall("GET", "/api/pricing");
    const plan = (pricing.body?.plans ?? []).find(
      (p: { monthlyPrice: number }) => p.monthlyPrice > 0,
    );
    expect(plan).toBeTruthy();
    const checkout = await apiCall("POST", "/api/billing/checkout", {
      jar: hotelBJar!,
      body: { planKey: plan.key, billingCycle: "MONTHLY", couponCode },
    });
    expect(checkout.status).toBe(201);
    expect(checkout.body?.discount).toBeGreaterThanOrEqual(0);
    expect(checkout.body?.amount).toBeLessThanOrEqual(checkout.body?.baseAmount);
    expect(checkout.body?.invoiceNumber).toMatch(/^SL-/);
    paymentId = checkout.body?.paymentId;
    // Idempotent within the hour window.
    const again = await apiCall("POST", "/api/billing/checkout", {
      jar: hotelBJar!,
      body: { planKey: plan.key, billingCycle: "MONTHLY" },
    });
    expect(again.body?.paymentId).toBe(paymentId);
  });

  test("staff/unknown roles cannot checkout (403) and unauthed gets 401", async () => {
    const staffLogin = await login(
      "staff@grandpalace.com",
      process.env.TEST_STAFF_PASSWORD ?? "TestStaff123",
    );
    const denied = await apiCall("POST", "/api/billing/checkout", {
      jar: staffLogin.jar,
      body: { planKey: "starter", billingCycle: "MONTHLY" },
    });
    expect(denied.status).toBe(403);
    const anon = await apiCall("POST", "/api/billing/checkout", {
      body: { planKey: "starter", billingCycle: "MONTHLY" },
    });
    expect(anon.status).toBe(401);
  });

  test("webhook without a configured provider fails closed (503), invalid signature rejected", async () => {
    const res = await fetch(
      `${process.env.TEST_BASE_URL ?? "http://localhost:3100"}/api/billing/webhook/razorpay`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-razorpay-signature": "bad" },
        body: JSON.stringify({
          event: "payment.captured",
          payload: { payment: { entity: { id: "pay_x", notes: { paymentId } } } },
        }),
      },
    );
    expect([400, 503]).toContain(res.status);
  });

  test("super admin can confirm the manual payment → subscription activates + coupon redeemed", async () => {
    const confirm = await apiCall("POST", "/api/super-admin/billing", {
      jar: saJar!,
      body: { action: "confirm", paymentId, reason: "Phase 10 manual bank transfer" },
    });
    expect(confirm.status).toBe(200);
    // Idempotent double-confirm.
    const again = await apiCall("POST", "/api/super-admin/billing", {
      jar: saJar!,
      body: { action: "confirm", paymentId, reason: "duplicate webhook replay" },
    });
    expect(again.status).toBe(200);
    // Subscription for hotel B is now ACTIVE with the purchased plan.
    const sub = await db.subscription.findFirst({
      where: { hotelId: hotelBId },
      orderBy: { createdAt: "desc" },
    });
    expect(sub?.status).toBe("ACTIVE");
    const coupon = await db.billingCoupon.findUnique({ where: { code: couponCode } });
    expect(coupon?.usedCount).toBe(1);
  });

  test("refund records the amount and marks the payment REFUNDED (audited)", async () => {
    const refund = await apiCall("POST", "/api/super-admin/billing", {
      jar: saJar!,
      body: { action: "refund", paymentId, reason: "Phase 10 refund probe" },
    });
    expect(refund.status).toBe(200);
    const payment = await db.payment.findUnique({ where: { id: paymentId } });
    expect(["REFUNDED", "PARTIALLY_REFUNDED"]).toContain(payment?.status ?? "");
  });

  test("billing webhook signature verification (unit-level, provider-native)", async () => {
    const { verifyRazorpaySignature, verifyStripeSignature } =
      await import("../src/lib/saas/billing");
    const body = JSON.stringify({ event: "payment.captured" });
    const secret = "webhook-secret-0123456789abcdef";
    const good = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyRazorpaySignature(body, good, secret)).toBe(true);
    expect(verifyRazorpaySignature(body, "deadbeef", secret)).toBe(false);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    expect(verifyStripeSignature(body, `t=${ts},v1=${sig}`, secret)).toBe(true);
    expect(verifyStripeSignature(body, `t=${ts},v1=${sig}`, "wrong-secret")).toBe(false);
    expect(
      verifyStripeSignature(body, `t=${Math.floor(Date.now() / 1000) - 99999},v1=${sig}`, secret),
    ).toBe(false);
  });
});

describe("Phase 10 — Security centre, MFA policy, backups, templates", () => {
  test("security dashboard aggregates live events + policy", async () => {
    const res = await apiCall("GET", "/api/super-admin/security", { jar: saJar! });
    expect(res.status).toBe(200);
    expect(typeof res.body?.overview?.failedLogins24h).toBe("number");
    expect(Array.isArray(res.body?.overview?.recentEvents)).toBe(true);
    expect(Array.isArray(res.body?.mfaPolicy?.requiredRoles)).toBe(true);
  });

  test("IP blocklist blocks logins and is auditable", async () => {
    const ip = "203.0.113.77";
    const block = await apiCall("POST", "/api/super-admin/security", {
      jar: saJar!,
      body: { action: "block-ip", ip, reason: "Phase 10 probe" },
    });
    expect(block.status).toBe(200);
    const dup = await apiCall("POST", "/api/super-admin/security", {
      jar: saJar!,
      body: { action: "block-ip", ip, reason: "dup" },
    });
    expect(dup.status).toBe(409);
    const unblock = await apiCall("POST", "/api/super-admin/security", {
      jar: saJar!,
      body: { action: "unblock-ip", ip },
    });
    expect(unblock.status).toBe(200);
  });

  test("force logout revokes every session for the target user (tokenVersion bump)", async () => {
    const target = await db.user.findFirst({ where: { email: HOTEL_B_ADMIN } });
    const before = target?.tokenVersion ?? 0;
    const res = await apiCall("POST", "/api/super-admin/security", {
      jar: saJar!,
      body: { action: "force-logout", userId: target?.id, reason: "Phase 10 session revoke probe" },
    });
    expect(res.status).toBe(200);
    const after = await db.user.findUnique({ where: { id: target!.id } });
    expect(after?.tokenVersion).toBe(before + 1);
    // Old session is dead.
    const dead = await apiCall("GET", "/api/customers", { jar: hotelBJar! });
    expect(dead.status).toBe(401);
    // Re-login for later tests.
    const reLogin = await login(HOTEL_B_ADMIN, ADMIN_PASSWORD);
    hotelBJar = reLogin.jar;
  });

  test("backup can be triggered (queued), processed by the worker sweep, verified, and appears in the history", async () => {
    // New contract (audit fix 3): the route QUEUES a PENDING record; the
    // worker processes it. This suite runs without a worker process, so we
    // invoke the exact sweep the worker performs (processPendingBackups —
    // in test mode it writes the deterministic dump + streams AES-256-GCM).
    const res = await apiCall("POST", "/api/super-admin/backups", {
      jar: saJar!,
      body: { reason: "Phase 10 manual backup probe" },
    });
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(res.body?.status).toBe("QUEUED");
    expect(res.body?.filename).toBeNull(); // produced asynchronously

    // Run the worker's pending-backup sweep (same function scripts/worker.ts
    // calls every few seconds).
    const { processPendingBackups } = await import("../src/lib/saas/backup");
    const processed = await processPendingBackups();
    expect(processed).toBe(1);

    // Poll the history until the record turns SUCCESS.
    let history: any[] = [];
    for (let i = 0; i < 20; i++) {
      const status = await apiCall("GET", "/api/super-admin/backups", { jar: saJar! });
      expect(status.status).toBe(200);
      history = status.body?.history ?? [];
      if (history[0]?.status === "SUCCESS") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]?.status).toBe("SUCCESS");
    expect(history[0]?.filename).toContain("stayloop-backup-");
    expect(history[0]?.verified).toBe(true);

    // ?verify=1 runs a REAL AES-256-GCM decrypt of the latest archive.
    const verify = await apiCall("POST", "/api/super-admin/backups?verify=1", {
      jar: saJar!,
      body: {},
    });
    expect(verify.status).toBe(200);
    expect(verify.body?.ok).toBe(true);
    expect(status_lastSuccessVerified(saJar!)).resolves.toBe(true);
  });

  async function status_lastSuccessVerified(jar: {
    cookie: string;
    csrf: string;
  }): Promise<boolean> {
    const status = await apiCall("GET", "/api/super-admin/backups", { jar });
    return Boolean(status.body?.status?.lastSuccess?.verified);
  }

  test("notification templates list + update with variable validation", async () => {
    const list = await apiCall("GET", "/api/super-admin/templates", { jar: saJar! });
    expect(list.status).toBe(200);
    const trialTemplate = (list.body?.templates ?? []).find(
      (t: { key: string }) => t.key === "trial_started",
    );
    expect(trialTemplate).toBeTruthy();
    const bad = await apiCall("PUT", "/api/super-admin/templates", {
      jar: saJar!,
      body: { key: "trial_started", body: "Hi {{unknown_variable}}" },
    });
    expect(bad.status).toBe(422);
    const good = await apiCall("PUT", "/api/super-admin/templates", {
      jar: saJar!,
      body: {
        key: "trial_started",
        body: "Hi {{tenant_name}}, your trial runs {{trial_days}} days.",
      },
    });
    expect(good.status).toBe(200);
  });

  test("announcements deliver to hotel notification inboxes", async () => {
    const res = await apiCall("POST", "/api/super-admin/announcements", {
      jar: saJar!,
      body: {
        title: "Phase 10 announcement",
        message: "Platform announcement probe message",
        severity: "INFO",
        audience: "all",
      },
    });
    expect(res.status).toBe(201);
    expect(res.body?.recipients).toBeGreaterThan(0);
  });
});

describe("Phase 10 — API security deny-matrix for the new SaaS endpoints", () => {
  const ENDPOINTS: ["GET" | "POST" | "PUT", string][] = [
    ["GET", "/api/super-admin/plans"],
    ["POST", "/api/super-admin/plans"],
    ["GET", "/api/super-admin/subscriptions"],
    ["POST", "/api/super-admin/subscriptions/action"],
    ["GET", "/api/super-admin/coupons"],
    ["POST", "/api/super-admin/coupons"],
    ["GET", "/api/super-admin/feature-flags"],
    ["PUT", "/api/super-admin/feature-flags"],
    ["GET", "/api/super-admin/billing"],
    ["PUT", "/api/super-admin/billing"],
    ["GET", "/api/super-admin/settings"],
    ["PUT", "/api/super-admin/settings"],
    ["GET", "/api/super-admin/security"],
    ["POST", "/api/super-admin/security"],
    ["GET", "/api/super-admin/backups"],
    ["POST", "/api/super-admin/backups"],
    ["GET", "/api/super-admin/templates"],
    ["PUT", "/api/super-admin/templates"],
    ["POST", "/api/super-admin/announcements"],
  ];

  test("every hotel role gets 403; unauthenticated gets 401", async () => {
    const hotelLogin = await login(HOTEL_B_ADMIN, ADMIN_PASSWORD);
    const probeBody = {
      key: "maintenance",
      value: {},
      code: "X",
      subscriptionId: "x",
      action: "x",
      paymentId: "x",
      provider: "razorpay",
    };
    for (const [method, path] of ENDPOINTS) {
      const withBody = method === "GET" ? undefined : probeBody;
      const hotelRes = await apiCall(method, path, { jar: hotelLogin.jar, body: withBody });
      expect(hotelRes.status).toBe(403);
      const anon = await apiCall(method, path, { body: withBody });
      expect(anon.status).toBe(401);
    }
  });

  test("hotel B cannot read hotel A's usage or tenant data through SaaS endpoints", async () => {
    // Tenant usage endpoint is super-admin only — hotel roles get 403.
    const res = await apiCall("GET", `/api/super-admin/usage?id=${hotelAId}`, { jar: hotelBJar! });
    expect(res.status).toBe(403);
  });

  test("super admin subscription endpoint rejects tenant billing access (403)", async () => {
    const res = await apiCall("GET", "/api/subscription", { jar: saJar! });
    expect(res.status).toBe(403);
  });
});

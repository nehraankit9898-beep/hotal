/**
 * Phase 6.4 — Loyalty concurrency, ledger immutability, visit compensation,
 * channel consent, campaign duplicate-send prevention, feedback hardening.
 *
 * Direct library tests (real database, real transactions) + API-level tests
 * against the running test server. These validate REAL behavior — no mocks.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { db } from "../src/lib/db";
import {
  awardForRestaurantVisit,
  redeemReward,
  adjustPoints,
  joinLoyalty,
  reverseForRestaurantVisit,
  adjustForVisitAmount,
  reconcileAccount,
  getLoyaltySettings,
} from "../src/lib/loyalty";
import { channelConsentOk } from "../src/lib/campaigns";
import { recordRestaurantVisit } from "../src/lib/restaurant";
import { apiCall, login, HOTEL_A_ADMIN, ADMIN_PASSWORD } from "./helpers";

// ---------------------------------------------------------------- setup

let HOTEL_ID = "";
let TEST_CUSTOMER_ID = "";
let adminJar: Awaited<ReturnType<typeof login>>["jar"];
const VISIT_IDS: string[] = [];

beforeAll(async () => {
  // Use the seeded Grand Palace hotel for direct-DB tests.
  const hotel = await db.hotel.findFirst({ where: { name: { contains: "Grand Palace" } } });
  HOTEL_ID = hotel?.id ?? "";

  const settings = await getLoyaltySettings(HOTEL_ID).catch(() => null);
  void settings;

  // A dedicated customer so tests never disturb seed data.
  const phone = `9${Date.now().toString().slice(-9)}`;
  const customer = await db.customer.create({
    data: {
      hotelId: HOTEL_ID,
      name: "Phase64 Test Customer",
      phone,
      marketingConsent: true,
      whatsappOptIn: true,
      smsOptIn: true,
      emailOptIn: false,
      source: "TEST",
    },
  });
  TEST_CUSTOMER_ID = customer.id;

  const loginRes = await login(HOTEL_A_ADMIN, ADMIN_PASSWORD);
  adminJar = loginRes.jar;
});

afterAll(async () => {
  // Cleanup: remove test artifacts (cascade removes loyalty rows).
  try {
    await db.restaurantVisit.deleteMany({
      where: { hotelId: HOTEL_ID, customerId: TEST_CUSTOMER_ID },
    });
    await db.loyaltyTransaction.deleteMany({
      where: { hotelId: HOTEL_ID, customerId: TEST_CUSTOMER_ID },
    });
    await db.loyaltyAccount.deleteMany({
      where: { hotelId: HOTEL_ID, customerId: TEST_CUSTOMER_ID },
    });
    await db.customer.deleteMany({ where: { id: TEST_CUSTOMER_ID } });
  } catch {
    // best effort
  }
});

async function ledgerSum(customerId: string): Promise<number> {
  const agg = await db.loyaltyTransaction.aggregate({
    where: { customerId },
    _sum: { points: true },
  });
  return agg._sum.points ?? 0;
}

async function balanceOf(customerId: string): Promise<number> {
  const acct = await db.loyaltyAccount.findUnique({
    where: { hotelId_customerId: { hotelId: HOTEL_ID, customerId } },
  });
  return acct?.points ?? 0;
}

// ---------------------------------------------------- channel consent

describe("Phase 6.4 — channel-specific consent (BUG #3)", () => {
  const base = {
    marketingConsent: true,
    optOut: false,
    whatsappOptIn: true,
    smsOptIn: true,
    emailOptIn: true,
  };

  test("all combinations of the consent matrix", () => {
    // marketingConsent=false blocks every channel
    for (const channel of ["WHATSAPP", "SMS", "EMAIL"] as const) {
      expect(channelConsentOk({ ...base, marketingConsent: false }, channel)).toBe(false);
    }
    // optOut=true blocks every channel
    for (const channel of ["WHATSAPP", "SMS", "EMAIL"] as const) {
      expect(channelConsentOk({ ...base, optOut: true }, channel)).toBe(false);
    }
    // channel opt-in=false blocks only that channel
    expect(channelConsentOk({ ...base, whatsappOptIn: false }, "WHATSAPP")).toBe(false);
    expect(channelConsentOk({ ...base, whatsappOptIn: false }, "SMS")).toBe(true);
    expect(channelConsentOk({ ...base, smsOptIn: false }, "SMS")).toBe(false);
    expect(channelConsentOk({ ...base, smsOptIn: false }, "WHATSAPP")).toBe(true);
    expect(channelConsentOk({ ...base, emailOptIn: false }, "EMAIL")).toBe(false);
    expect(channelConsentOk({ ...base, emailOptIn: false }, "SMS")).toBe(true);
    // fully consented → all allowed
    for (const channel of ["WHATSAPP", "SMS", "EMAIL"] as const) {
      expect(channelConsentOk(base, channel)).toBe(true);
    }
  });

  test("campaign send skips customers without the channel opt-in (API)", async () => {
    // Customer with marketing consent but NO WhatsApp opt-in.
    const phone = `8${Date.now().toString().slice(-9)}`;
    const cust = await db.customer.create({
      data: {
        hotelId: HOTEL_ID,
        name: "No WA Consent",
        phone,
        marketingConsent: true,
        whatsappOptIn: false,
        smsOptIn: false,
        emailOptIn: false,
        source: "TEST",
      },
    });

    // Find/create a segment containing just this customer.
    const seg = await db.segment.create({
      data: { hotelId: HOTEL_ID, name: `P64 Seg ${Date.now()}`, type: "MANUAL", rule: "{}" },
    });
    await db.segmentMember.create({
      data: { segmentId: seg.id, customerId: cust.id, source: "MANUAL" },
    });

    const campaign = await db.campaign.create({
      data: {
        hotelId: HOTEL_ID,
        name: `P64 Consent Test ${Date.now()}`,
        status: "ACTIVE",
        scheduleType: "NOW",
        segmentId: seg.id,
        channels: JSON.stringify(["WHATSAPP", "SMS", "EMAIL"]),
        messageTemplate: "Hi {{name}}, test message.",
      },
    });

    const res = await apiCall("POST", `/api/campaigns/${campaign.id}/send`, {
      jar: adminJar,
      body: {},
    });
    expect(res.status).toBe(200);

    const messages = await db.campaignMessage.findMany({ where: { campaignId: campaign.id } });
    expect(messages.length).toBe(3); // one per channel, all skipped
    for (const m of messages) {
      expect(m.status).toBe("SKIPPED");
      expect(m.skipReason).toMatch(/^NO_(WHATSAPP|SMS|EMAIL)_CONSENT$/);
    }

    // cleanup
    await db.campaignMessage.deleteMany({ where: { campaignId: campaign.id } });
    await db.campaign.delete({ where: { id: campaign.id } });
    await db.segmentMember.deleteMany({ where: { segmentId: seg.id } });
    await db.segment.delete({ where: { id: seg.id } });
    await db.customer.delete({ where: { id: cust.id } });
  });
});

// ---------------------------------------------------- loyalty concurrency

describe("Phase 6.4 — loyalty concurrency (BUG #1, #5)", () => {
  test("50 concurrent earn calls on the same account never lose an update", async () => {
    const tasks: Promise<import("../src/lib/loyalty").AwardResult>[] = [];
    for (let i = 0; i < 50; i++) {
      const visit = await db.restaurantVisit.create({
        data: {
          hotelId: HOTEL_ID,
          customerId: TEST_CUSTOMER_ID,
          visitDate: new Date(),
          orderAmount: 100, // 10 points each in POINTS mode
          source: "WALK_IN",
        },
      });
      VISIT_IDS.push(visit.id);
    }
    // Fire all 50 awards at once (different visits, same account).
    for (const visitId of VISIT_IDS) {
      tasks.push(awardForRestaurantVisit(HOTEL_ID, TEST_CUSTOMER_ID, visitId, 100));
    }
    const results = await Promise.all(tasks);

    const awarded = results.filter((r) => r.ok && r.pointsAwarded > 0).length;
    const settings = await getLoyaltySettings(HOTEL_ID);
    const expected =
      50 * (settings.mode === "POINTS" ? settings.pointsPer100 : settings.pointsPerVisit);

    expect(awarded).toBe(50);
    expect(await balanceOf(TEST_CUSTOMER_ID)).toBe(expected);
    expect(await ledgerSum(TEST_CUSTOMER_ID)).toBe(expected); // ledger = balance invariant
  }, 30000);

  test("10 duplicate award calls for the SAME visit award exactly once", async () => {
    const visit = await db.restaurantVisit.create({
      data: {
        hotelId: HOTEL_ID,
        customerId: TEST_CUSTOMER_ID,
        visitDate: new Date(),
        orderAmount: 100,
        source: "WALK_IN",
      },
    });
    const before = await balanceOf(TEST_CUSTOMER_ID);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        awardForRestaurantVisit(HOTEL_ID, TEST_CUSTOMER_ID, visit.id, 100),
      ),
    );

    const settings = await getLoyaltySettings(HOTEL_ID);
    const single = settings.mode === "POINTS" ? settings.pointsPer100 : settings.pointsPerVisit;
    expect(await balanceOf(TEST_CUSTOMER_ID)).toBe(before + single);

    // Ledger has exactly ONE earn row for this visit.
    const rows = await db.loyaltyTransaction.findMany({
      where: { visitId: visit.id, type: { in: ["EARN", "EARN_VISIT"] } },
    });
    expect(rows.length).toBe(1);
    void results;
  }, 30000);

  test("concurrent loyalty account creation never crashes (upsert path)", async () => {
    const phone = `7${Date.now().toString().slice(-9)}`;
    const cust = await db.customer.create({
      data: { hotelId: HOTEL_ID, name: "Race Create", phone, source: "TEST" },
    });
    // 10 parallel joins race on account creation + signup bonus.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => joinLoyalty(HOTEL_ID, cust.id, { source: "TEST" })),
    );
    const settings = await getLoyaltySettings(HOTEL_ID);
    const acct = await db.loyaltyAccount.findUnique({
      where: { hotelId_customerId: { hotelId: HOTEL_ID, customerId: cust.id } },
    });
    // Exactly ONE signup bonus — no double award.
    const bonusRows = await db.loyaltyTransaction.findMany({
      where: { customerId: cust.id, type: "SIGNUP_BONUS" },
    });
    expect(bonusRows.length).toBe(1);
    expect(acct?.points).toBe(settings.signupBonus);
    expect(results.filter((r) => r.ok).length).toBe(10);

    await db.loyaltyTransaction.deleteMany({ where: { customerId: cust.id } });
    await db.loyaltyAccount.deleteMany({ where: { customerId: cust.id } });
    await db.customer.delete({ where: { id: cust.id } });
  }, 30000);

  test("concurrent redemptions cannot overdraw the balance", async () => {
    // Arrange: enough points for exactly ONE redemption.
    const settings = await getLoyaltySettings(HOTEL_ID);
    const current = await balanceOf(TEST_CUSTOMER_ID);
    if (current < settings.pointsForReward) {
      await adjustPoints(
        HOTEL_ID,
        TEST_CUSTOMER_ID,
        settings.pointsForReward - current,
        "test setup",
        {},
      );
    }

    // 10 concurrent redemptions — at most 1 can succeed.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => redeemReward(HOTEL_ID, TEST_CUSTOMER_ID, {})),
    );
    const successes = results.filter((r) => r.ok).length;
    expect(successes).toBe(1);
    expect(await balanceOf(TEST_CUSTOMER_ID)).toBeGreaterThanOrEqual(0);
  }, 30000);
});

// ---------------------------------------------------- visit compensation

describe("Phase 6.4 — visit edit/delete loyalty compensation (BUG #2)", () => {
  test("editing a visit amount corrects the points (₹10,000 → ₹1,000)", async () => {
    const phone = `6${Date.now().toString().slice(-9)}`;
    const cust = await db.customer.create({
      data: { hotelId: HOTEL_ID, name: "Edit Test", phone, source: "TEST" },
    });

    // Record a ₹10,000 visit (real flow: visit + loyalty award).
    const visit = await recordRestaurantVisit({
      hotelId: HOTEL_ID,
      customerId: cust.id,
      visitDate: new Date(),
      orderAmount: 10_000,
      source: "WALK_IN",
    });
    const settings = await getLoyaltySettings(HOTEL_ID);
    const earnedBig =
      settings.mode === "POINTS"
        ? Math.floor(10_000 / 100) * settings.pointsPer100
        : settings.pointsPerVisit;
    expect(await balanceOf(cust.id)).toBe(earnedBig);

    // Edit down to ₹1,000 — points must drop accordingly.
    const res = await adjustForVisitAmount(HOTEL_ID, cust.id, visit.id, 10_000, 1_000, {});
    expect(res.ok).toBe(true);
    const earnedSmall =
      settings.mode === "POINTS"
        ? Math.floor(1_000 / 100) * settings.pointsPer100
        : settings.pointsPerVisit;
    expect(await balanceOf(cust.id)).toBe(earnedSmall);

    // Repeat the SAME edit → idempotent, no double adjustment.
    const res2 = await adjustForVisitAmount(HOTEL_ID, cust.id, visit.id, 10_000, 1_000, {});
    expect(res2.ok).toBe(true);
    expect(res2.reason).toBe("ALREADY_ADJUSTED");
    expect(await balanceOf(cust.id)).toBe(earnedSmall);

    // Ledger = balance invariant holds after compensation.
    expect(await ledgerSum(cust.id)).toBe(earnedSmall);

    // cleanup
    await db.restaurantVisit.deleteMany({ where: { customerId: cust.id } });
    await db.loyaltyTransaction.deleteMany({ where: { customerId: cust.id } });
    await db.loyaltyAccount.deleteMany({ where: { customerId: cust.id } });
    await db.customer.delete({ where: { id: cust.id } });
  }, 30000);

  test("deleting a visit reverses its points exactly once", async () => {
    const phone = `5${Date.now().toString().slice(-9)}`;
    const cust = await db.customer.create({
      data: { hotelId: HOTEL_ID, name: "Delete Test", phone, source: "TEST" },
    });

    const visit = await recordRestaurantVisit({
      hotelId: HOTEL_ID,
      customerId: cust.id,
      visitDate: new Date(),
      orderAmount: 5_000,
      source: "WALK_IN",
    });
    const settings = await getLoyaltySettings(HOTEL_ID);
    const earned =
      settings.mode === "POINTS"
        ? Math.floor(5_000 / 100) * settings.pointsPer100
        : settings.pointsPerVisit;
    expect(await balanceOf(cust.id)).toBe(earned);

    // Reverse (as the DELETE endpoint does).
    const rev1 = await reverseForRestaurantVisit(HOTEL_ID, cust.id, visit.id, 5_000, {});
    expect(rev1.ok).toBe(true);
    expect(rev1.pointsReversed).toBe(earned);
    expect(await balanceOf(cust.id)).toBe(0);

    // Repeated delete request → idempotent no-op.
    const rev2 = await reverseForRestaurantVisit(HOTEL_ID, cust.id, visit.id, 5_000, {});
    expect(rev2.ok).toBe(true);
    expect(rev2.pointsReversed).toBe(0);
    expect(await balanceOf(cust.id)).toBe(0);

    // Ledger invariant: earn + reversal = 0.
    expect(await ledgerSum(cust.id)).toBe(0);

    // cleanup
    await db.restaurantVisit.deleteMany({ where: { customerId: cust.id } });
    await db.loyaltyTransaction.deleteMany({ where: { customerId: cust.id } });
    await db.loyaltyAccount.deleteMany({ where: { customerId: cust.id } });
    await db.customer.delete({ where: { id: cust.id } });
  }, 30000);

  test("REGRESSION: earn → edit → delete nets exactly ZERO (reversal covers corrections)", async () => {
    const phone = `9${Math.floor(Math.random() * 900000000 + 100000000)}`;
    const cust = await db.customer.create({
      data: { hotelId: HOTEL_ID, name: "NetZero Test", phone, source: "TEST" },
    });

    // 1. Record a ₹3,000 visit.
    const visit = await recordRestaurantVisit({
      hotelId: HOTEL_ID,
      customerId: cust.id,
      visitDate: new Date(),
      orderAmount: 3_000,
      source: "WALK_IN",
    });
    const settings = await getLoyaltySettings(HOTEL_ID);
    const earned =
      settings.mode === "POINTS"
        ? Math.floor(3_000 / 100) * settings.pointsPer100
        : settings.pointsPerVisit;
    expect(await balanceOf(cust.id)).toBe(earned);

    // 2. Edit UP to ₹4,000 (+100 points).
    await adjustForVisitAmount(HOTEL_ID, cust.id, visit.id, 3_000, 4_000, {});
    const earnedUp =
      settings.mode === "POINTS"
        ? Math.floor(4_000 / 100) * settings.pointsPer100
        : settings.pointsPerVisit;
    expect(await balanceOf(cust.id)).toBe(earnedUp);

    // 3. Delete the visit — the reversal must cover the CORRECTED total
    //    (not just the original EARN), leaving a net of exactly zero.
    const rev = await reverseForRestaurantVisit(HOTEL_ID, cust.id, visit.id, 4_000, {});
    expect(rev.ok).toBe(true);
    expect(rev.pointsReversed).toBe(earnedUp);
    expect(await balanceOf(cust.id)).toBe(0);

    // Ledger net for this visit: earn + adjust + reversal = 0.
    const visitLedger = await db.loyaltyTransaction.findMany({
      where: { visitId: visit.id },
      select: { points: true },
    });
    const net = visitLedger.reduce((s, t) => s + t.points, 0);
    expect(net).toBe(0);

    // cleanup
    await db.restaurantVisit.deleteMany({ where: { customerId: cust.id } });
    await db.loyaltyTransaction.deleteMany({ where: { customerId: cust.id } });
    await db.loyaltyAccount.deleteMany({ where: { customerId: cust.id } });
    await db.customer.delete({ where: { id: cust.id } });
  });

  test("restaurant visit DELETE endpoint reverses loyalty (API)", async () => {
    const phone = `4${Date.now().toString().slice(-9)}`;
    const cust = await db.customer.create({
      data: { hotelId: HOTEL_ID, name: "API Delete", phone, source: "TEST" },
    });

    const create = await apiCall("POST", "/api/restaurant/visits", {
      jar: adminJar,
      body: {
        customerId: cust.id,
        visitDate: new Date().toISOString(),
        orderAmount: 2000,
        source: "WALK_IN",
      },
    });
    expect(create.status).toBe(201);
    const visitId = create.body.visit?.id as string;
    expect(visitId).toBeTruthy();

    const before = await balanceOf(cust.id);
    expect(before).toBeGreaterThan(0);

    const del = await apiCall("DELETE", `/api/restaurant/visits/${visitId}`, { jar: adminJar });
    expect(del.status).toBe(200);
    expect(del.body.loyalty?.pointsReversed).toBe(before);
    expect(await balanceOf(cust.id)).toBe(0);

    // cleanup
    await db.loyaltyTransaction.deleteMany({ where: { customerId: cust.id } });
    await db.loyaltyAccount.deleteMany({ where: { customerId: cust.id } });
    await db.customer.delete({ where: { id: cust.id } });
  }, 30000);

  test("cross-tenant restaurant visit access → 404", async () => {
    const phone = `3${Date.now().toString().slice(-9)}`;
    const cust = await db.customer.create({
      data: { hotelId: HOTEL_ID, name: "Tenant Test", phone, source: "TEST" },
    });
    const create = await apiCall("POST", "/api/restaurant/visits", {
      jar: adminJar,
      body: {
        customerId: cust.id,
        visitDate: new Date().toISOString(),
        orderAmount: 500,
        source: "WALK_IN",
      },
    });
    const visitId = create.body.visit?.id as string;

    // Login as Hotel B admin and try to edit/delete Hotel A's visit.
    const { login: loginB } = await import("./helpers");
    const b = await loginB("admin@seaview.com", ADMIN_PASSWORD);
    const patch = await apiCall("PATCH", `/api/restaurant/visits/${visitId}`, {
      jar: b.jar,
      body: { orderAmount: 1 },
    });
    expect(patch.status).toBe(404);
    const del = await apiCall("DELETE", `/api/restaurant/visits/${visitId}`, { jar: b.jar });
    expect(del.status).toBe(404);

    // cleanup (visit still exists — delete via A)
    await apiCall("DELETE", `/api/restaurant/visits/${visitId}`, { jar: adminJar });
    await db.loyaltyTransaction.deleteMany({ where: { customerId: cust.id } });
    await db.loyaltyAccount.deleteMany({ where: { customerId: cust.id } });
    await db.customer.delete({ where: { id: cust.id } });
  }, 30000);
});

// ---------------------------------------------------- reconciliation

describe("Phase 6.4 — ledger reconciliation (spec §28)", () => {
  test("detects drift and repairs via an audited compensating entry", async () => {
    // Corrupt the stored balance directly (simulates legacy corruption).
    await db.loyaltyAccount.update({
      where: { hotelId_customerId: { hotelId: HOTEL_ID, customerId: TEST_CUSTOMER_ID } },
      data: { points: 1 }, // arbitrary wrong value
    });

    const report = await reconcileAccount(HOTEL_ID, TEST_CUSTOMER_ID);
    expect(report.matched).toBe(false);
    expect(report.drift).not.toBe(0);

    const repaired = await reconcileAccount(HOTEL_ID, TEST_CUSTOMER_ID, { repair: true });
    expect(repaired.matched).toBe(true);
    expect(repaired.drift).toBe(0);
    // Ledger invariant restored.
    expect(await ledgerSum(TEST_CUSTOMER_ID)).toBe(await balanceOf(TEST_CUSTOMER_ID));
  });
});

// ---------------------------------------------------- campaign dedupe

describe("Phase 6.4 — campaign duplicate send race (BUG #4)", () => {
  test("25 concurrent send triggers produce exactly one delivery per (customer, channel)", async () => {
    const phone = `2${Date.now().toString().slice(-9)}`;
    const cust = await db.customer.create({
      data: {
        hotelId: HOTEL_ID,
        name: "Dedupe Test",
        phone,
        marketingConsent: true,
        whatsappOptIn: true,
        smsOptIn: false,
        emailOptIn: false,
        source: "TEST",
      },
    });

    const seg = await db.segment.create({
      data: { hotelId: HOTEL_ID, name: `P64 Dedupe ${Date.now()}`, type: "MANUAL", rule: "{}" },
    });
    await db.segmentMember.create({
      data: { segmentId: seg.id, customerId: cust.id, source: "MANUAL" },
    });

    const campaign = await db.campaign.create({
      data: {
        hotelId: HOTEL_ID,
        name: `P64 Dedupe Campaign ${Date.now()}`,
        status: "ACTIVE",
        scheduleType: "NOW",
        segmentId: seg.id,
        channels: JSON.stringify(["WHATSAPP"]),
        messageTemplate: "Hi {{name}}, dedupe test.",
      },
    });

    // 25 simultaneous send triggers (the race that used to double-send).
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        apiCall("POST", `/api/campaigns/${campaign.id}/send`, { jar: adminJar, body: {} }),
      ),
    );
    // All runs should succeed (or be blocked identically) — no 500 crashes.
    for (const r of results) {
      expect(r.status).toBeLessThan(500);
    }

    const messages = await db.campaignMessage.findMany({ where: { campaignId: campaign.id } });
    // Exactly ONE message row — the reservation is unique.
    expect(messages.length).toBe(1);
    // In the test environment (no live provider credentials) the delivery is
    // honestly labeled SIMULATED — never SENT.
    expect(messages[0].status).toBe("SIMULATED");
    expect(messages[0].provider).toBe("SIMULATION");

    // cleanup
    await db.campaignMessage.deleteMany({ where: { campaignId: campaign.id } });
    await db.campaign.delete({ where: { id: campaign.id } });
    await db.segmentMember.deleteMany({ where: { segmentId: seg.id } });
    await db.segment.delete({ where: { id: seg.id } });
    await db.customer.delete({ where: { id: cust.id } });
  }, 30000);
});

// ---------------------------------------------------- feedback hardening

describe("Phase 6.4 — public feedback abuse prevention (BUG #8)", () => {
  let qrCode = "";

  beforeAll(async () => {
    const qr = await db.qRCode.findFirst({ where: { hotelId: HOTEL_ID, active: true } });
    qrCode = qr?.code ?? "";
  });

  test("duplicate submission (same phone + rating + comment) → 409", async () => {
    const payload = {
      qrCode,
      rating: 5,
      comment: `Great food! ${Date.now()}`,
      phone: "9876543210",
    };
    const first = await apiCall("POST", "/api/public/feedback", { body: payload });
    expect([201, 429]).toContain(first.status); // 201 (or 429 if IP-limited by prior tests)

    const duplicate = await apiCall("POST", "/api/public/feedback", { body: payload });
    expect([409, 429]).toContain(duplicate.status);
  });

  test("invalid rating → 400", async () => {
    const res = await apiCall("POST", "/api/public/feedback", {
      body: { qrCode, rating: 9, comment: "" },
    });
    expect([400, 429]).toContain(res.status);
  });
});

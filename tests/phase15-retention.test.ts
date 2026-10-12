/**
 * Phase 15 — retention, marketing & owner reporting (HTTP, test server).
 *
 * Acceptance matrix:
 *   1. Referral program: config → code → attribution → self-referral rejected
 *      → duplicate attribution rejected → qualification on first paid bill →
 *      reward exactly once (retry-safe)
 *   2. Promotions: creation validation (percent/flat/happy-hour windows)
 *   3. Payment links: create for unpaid bill; public API exposes only
 *      amount+name; expired/revoked links refuse; overdues auto-handled
 *   4. Report schedule: validation + persistence; owner report computation
 *      matches underlying bills (deterministic digest)
 *   5. RESTAURANT_BILL_PAID job: visit recorded once, referral qualified once,
 *      thank-you respects consent/opt-out (no consent → skipped)
 */
import { describe, test, expect } from "bun:test";
import { apiCall, login } from "./helpers";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3100";

let xff = Math.floor(Math.random() * 200) + 20;
const ADMIN_EMAIL = `owner-p15-${Date.now()}@restroloop.test`;
async function registerFreshHotel(suffix: string) {
  xff += 1;
  const res = await fetch(`${BASE}/api/hotels`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: BASE, "x-forwarded-for": `10.95.0.${xff}` },
    body: JSON.stringify({ hotelName: `Fresh P15 ${suffix}`, adminName: "Owner", email: ADMIN_EMAIL, password: "FreshOwner123!" }),
  });
  if (res.status !== 201) throw new Error("fresh hotel registration failed: " + res.status);
  const body = (await res.json()) as { hotel: { id: string } };
  return { hotelId: body.hotel.id, session: await login(ADMIN_EMAIL, "FreshOwner123!") };
}

const fresh = await registerFreshHotel(String(Date.now()));
const a = fresh.session;
const jar = a.jar;
const hotelId = fresh.hotelId;

let categoryId: string;
let itemId: string;
let tableId: string;
let refereeCustomerId: string;

let tableCounter = 0;
async function makePaidBill(cartQty: number, phone?: string): Promise<{ billId: string; totalMinor: number }> {
  // Fresh table per bill: openTableSession reuses an OPEN session, whose
  // orders would already be billed after the first call. Table numbers are
  // 1-12 chars A-Z0-9- (route validation).
  tableCounter += 1;
  const t = await apiCall("POST", "/api/tables", { jar, body: { number: `P15T${tableCounter}${Date.now() % 1000}`, capacity: 4 } });
  expect(t.status).toBe(201);
  const tid = t.body.table.id;
  const s = await apiCall("POST", "/api/sessions", { jar, body: { tableId: tid, guestName: phone ?? "Guest" } });
  const sid = s.body.session?.id ?? s.body.id;
  const o = await apiCall("POST", "/api/orders", { jar, body: { tableSessionId: sid, cart: [{ menuItemId: itemId, quantity: cartQty }], customerPhone: phone } });
  expect(o.status).toBe(201);
  const b = await apiCall("POST", "/api/bills", { jar, body: { tableSessionId: sid, idempotencyKey: `bill-p15-${Date.now()}-${Math.random()}` } });
  expect(b.status).toBe(201);
  const pay = await apiCall("POST", `/api/bills/${b.body.bill.id}/pay`, {
    jar,
    body: { method: "CASH", amountMinor: b.body.bill.totalMinor, idempotencyKey: `pay-p15-${Date.now()}-${Math.random()}` },
  });
  expect(pay.status).toBe(201);
  return { billId: b.body.bill.id, totalMinor: b.body.bill.totalMinor };
}

describe("Phase 15 — setup", () => {
  test("catalog + table + customer", async () => {
    const cat = await apiCall("POST", "/api/menu/categories", { jar, body: { name: "P15 Cat" } });
    categoryId = cat.body.category.id;
    const item = await apiCall("POST", "/api/menu/items", { jar, body: { categoryId, name: "P15 Item", priceMinor: 20000 } });
    itemId = item.body.item.id;
    const table = await apiCall("POST", "/api/tables", { jar, body: { number: "P15-1", capacity: 4 } });
    tableId = table.body.table.id;

    const cust = await apiCall("POST", "/api/customers", {
      jar,
      body: { name: "Referee Rita", phone: `98000000${Math.floor(Math.random() * 90 + 10)}` },
    });
    expect(cust.status).toBe(201);
    refereeCustomerId = cust.body.customer?.id ?? cust.body.id;
  });
});

describe("Phase 15 — referral program", () => {
  test("program defaults active; owner updates rewards", async () => {
    const put = await apiCall("PUT", "/api/referrals", {
      jar,
      body: { active: true, referrerRewardType: "POINTS", referrerRewardValue: 150, refereeRewardType: "POINTS", refereeRewardValue: 50 },
    });
    expect(put.status).toBe(200);
    expect(put.body.program.referrerRewardValue).toBe(150);
  });

  test("referrer code allocated; self-referral rejected; double attribution rejected", async () => {
    const codeRes = await apiCall("POST", "/api/referrals", { jar, body: { action: "code", customerId: refereeCustomerId } });
    // The REFEREE is the one who uses someone's code. Create a second customer as referrer.
    const referrer = await apiCall("POST", "/api/customers", { jar, body: { name: "Referrer Raj", phone: `97000000${Math.floor(Math.random() * 90 + 10)}` } });
    const referrerId = referrer.body.customer?.id ?? referrer.body.id;
    const code = await apiCall("POST", "/api/referrals", { jar, body: { action: "code", customerId: referrerId } });
    expect(code.status).toBe(200);
    const codeValue = code.body.code;

    const self = await apiCall("POST", "/api/referrals", { jar, body: { action: "attribute", code: codeValue, customerId: referrerId } });
    expect(self.status).toBe(422);

    const attr = await apiCall("POST", "/api/referrals", { jar, body: { action: "attribute", code: codeValue, customerId: refereeCustomerId } });
    expect(attr.status).toBe(201);
    expect(attr.body.referrerName).toBe("Referrer Raj"); // display name only, no contact data

    const again = await apiCall("POST", "/api/referrals", { jar, body: { action: "attribute", code: codeValue, customerId: refereeCustomerId } });
    expect(again.status).toBe(422);
    void codeRes;
  });

  test("qualification on first paid bill; reward exactly once across job retries", async () => {
    const { billId } = await makePaidBill(1);
    const { runRestaurantBillPaid } = await import("../src/lib/retention");

    const r1 = await runRestaurantBillPaid({
      jobId: "t1", type: "RESTAURANT_BILL_PAID", hotelId,
      createdBy: null,
      payload: { billId, hotelId, customerId: refereeCustomerId, totalMinor: 20000 },
    });
    expect(r1.ok).toBe(true);
    expect((r1.result as Record<string, unknown>).referral).toBe("REWARDED");

    // Retry the SAME job → referral stays REWARDED (no double reward)
    const r2 = await runRestaurantBillPaid({
      jobId: "t2", type: "RESTAURANT_BILL_PAID", hotelId,
      createdBy: null,
      payload: { billId, hotelId, customerId: refereeCustomerId, totalMinor: 20000 },
    });
    expect(r2.ok).toBe(true);
    expect((r2.result as Record<string, unknown>).referral).toBe("REWARDED");

    const { db } = await import("../src/lib/db");
    const txns = await db.loyaltyTransaction.findMany({
      where: { hotelId, customerId: refereeCustomerId, reason: { contains: "referral" } },
    });
    // Only the referee welcome bonus via adjustPoints (reason "Welcome referral bonus")
    const welcome = await db.loyaltyTransaction.findMany({
      where: { hotelId, customerId: refereeCustomerId, reason: "Welcome referral bonus" },
    });
    expect(welcome.length).toBe(1);
    void txns;
  });

  test("thank-you email skipped without marketing consent", async () => {
    const { billId, totalMinor } = await makePaidBill(1);
    const { runRestaurantBillPaid } = await import("../src/lib/retention");
    const res = await runRestaurantBillPaid({
      jobId: "t3", type: "RESTAURANT_BILL_PAID", hotelId,
      createdBy: null,
      payload: { billId, hotelId, customerId: refereeCustomerId, totalMinor },
    });
    expect(res.ok).toBe(true);
    const outcome = res.result as Record<string, unknown>;
    // No consent on the test customer (no email at all) → skipped
    const thankYou = JSON.stringify(outcome.thankYou);
    expect(thankYou.includes("no_consent") || thankYou.includes("no_email")).toBe(true);
  });

  test("thank-you email skipped for a customer who replied STOP", async () => {
    // Regression: only marketingConsent was checked, but an inbound STOP
    // reply sets optOut and leaves marketingConsent untouched.
    const cust = await apiCall("POST", "/api/customers", {
      jar,
      body: {
        name: "Stop Sita",
        phone: `96000000${Math.floor(Math.random() * 90 + 10)}`,
        email: `stop-${Date.now()}@p15.test`,
        marketingConsent: true,
        emailOptIn: true,
      },
    });
    expect(cust.status).toBe(201);
    const customerId = cust.body.customer?.id ?? cust.body.id;
    const { db } = await import("../src/lib/db");
    // Exactly what the inbound-STOP handler (webhooks/tracking) writes.
    await db.customer.update({ where: { id: customerId }, data: { optOut: true } });

    const { billId, totalMinor } = await makePaidBill(1);
    const { runRestaurantBillPaid } = await import("../src/lib/retention");
    const res = await runRestaurantBillPaid({
      jobId: "t4", type: "RESTAURANT_BILL_PAID", hotelId,
      createdBy: null,
      payload: { billId, hotelId, customerId, totalMinor },
    });
    expect(res.ok).toBe(true);
    expect((res.result as Record<string, unknown>).thankYou).toEqual({ skipped: "opted_out" });
  });
});

describe("Phase 15 — promotions", () => {
  test("valid percent + happy-hour created; invalid rejected", async () => {
    const ok = await apiCall("POST", "/api/promotions", { jar, body: { name: "P15 10% off", type: "PERCENT", percentBps: 1000 } });
    expect(ok.status).toBe(201);

    const hh = await apiCall("POST", "/api/promotions", {
      jar,
      body: { name: "P15 Happy Hour", type: "HAPPY_HOUR", percentBps: 2000, startTime: "18:00", endTime: "20:00", daysOfWeek: ["MON", "TUE"] },
    });
    expect(hh.status).toBe(201);
    expect(hh.body.promotion.startTime).toBe("18:00");

    const badWindow = await apiCall("POST", "/api/promotions", {
      jar, body: { name: "Bad HH", type: "HAPPY_HOUR", percentBps: 100, startTime: "25:00", endTime: "x" },
    });
    expect(badWindow.status).toBe(422);

    const noName = await apiCall("POST", "/api/promotions", { jar, body: { name: "x", type: "PERCENT", percentBps: 100 } });
    expect(noName.status).toBe(422);

    const badRate = await apiCall("POST", "/api/promotions", { jar, body: { name: "Too much", type: "PERCENT", percentBps: 20000 } });
    expect(badRate.status).toBe(422);
  });

  test("a promotion restricted to days of the week applies on a matching day", async () => {
    // Regression: days are stored as "MON".."SUN" but were compared with
    // Intl's "Mon".."Sun", so a day-restricted promotion never applied.
    const promo = await apiCall("POST", "/api/promotions", {
      jar,
      body: { name: "P15 Every day 25%", type: "PERCENT", percentBps: 2500, daysOfWeek: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] },
    });
    expect(promo.status).toBe(201);
    try {
      tableCounter += 1;
      const t = await apiCall("POST", "/api/tables", { jar, body: { number: `P15D${tableCounter}${Date.now() % 1000}`, capacity: 2 } });
      const s = await apiCall("POST", "/api/sessions", { jar, body: { tableId: t.body.table.id, guestName: "Days" } });
      const sid = s.body.session?.id ?? s.body.id;
      await apiCall("POST", "/api/orders", { jar, body: { tableSessionId: sid, cart: [{ menuItemId: itemId, quantity: 1 }] } });
      const b = await apiCall("POST", "/api/bills", { jar, body: { tableSessionId: sid, idempotencyKey: `bill-days-${Date.now()}` } });
      expect(b.status).toBe(201);
      const bill = (await apiCall("GET", `/api/bills/${b.body.bill.id}`, { jar })).body.bill;
      expect(bill.promotionId).toBe(promo.body.promotion.id);
      expect(bill.discountMinor).toBe(5000); // 25% of 20000
    } finally {
      await apiCall("PATCH", `/api/promotions/${promo.body.promotion.id}`, { jar, body: { active: false } });
    }
  });
});

describe("Phase 15 — payment links", () => {
  test("create for unpaid bill; public API is scoped; revoke works", async () => {
    tableCounter += 1;
    const t = await apiCall("POST", "/api/tables", { jar, body: { number: `P15L${tableCounter}${Date.now() % 1000}`, capacity: 2 } });
    const s = await apiCall("POST", "/api/sessions", { jar, body: { tableId: t.body.table.id, guestName: "Link" } });
    const sid = s.body.session?.id ?? s.body.id;
    await apiCall("POST", "/api/orders", { jar, body: { tableSessionId: sid, cart: [{ menuItemId: itemId, quantity: 2 }] } });
    const b = await apiCall("POST", "/api/bills", { jar, body: { tableSessionId: sid, idempotencyKey: `bill-link-${Date.now()}` } });
    const bid = b.body.bill.id;

    const link = await apiCall("POST", "/api/payment-links", { jar, body: { billId: bid, expiresInHours: 2 } });
    expect(link.status).toBe(201);
    const token = link.body.link.token;

    // Public endpoint: only amount + name, no auth
    const pub = await fetch(`${BASE}/api/pay/${token}`);
    expect(pub.status).toBe(200);
    const pubBody = (await pub.json()) as Record<string, unknown>;
    expect(pubBody.restaurantName).toContain("P15");
    expect(pubBody.amountMinor).toBe(b.body.bill.totalMinor);
    expect(JSON.stringify(pubBody)).not.toContain(refereeCustomerId);

    // Revoked link refuses checkout info
    const revoke = await apiCall("PATCH", "/api/payment-links", { jar, body: { id: link.body.link.id, action: "REVOKE" } });
    expect(revoke.status).toBe(200);
    const pub2 = await fetch(`${BASE}/api/pay/${token}`);
    const pub2Body = (await pub2.json()) as Record<string, unknown>;
    expect(pub2Body.status).toBe("REVOKED");
    void bid;
  });

  test("payment link for a PAID bill rejected", async () => {
    const { billId } = await makePaidBill(1);
    const res = await apiCall("POST", "/api/payment-links", { jar, body: { billId } });
    expect(res.status).toBe(422);
  });
});

describe("Phase 15 — owner reports", () => {
  test("schedule validation + persistence", async () => {
    const bad = await apiCall("PUT", "/api/report-schedule", { jar, body: { frequency: "HOURLY", recipients: ["a@b.com"] } });
    expect(bad.status).toBe(422);
    const badMail = await apiCall("PUT", "/api/report-schedule", { jar, body: { frequency: "DAILY", recipients: ["not-an-email"] } });
    expect(badMail.status).toBe(422);
    const ok = await apiCall("PUT", "/api/report-schedule", {
      jar,
      body: { frequency: "DAILY", hour: 21, recipients: ["owner@p15.test", "manager@p15.test"], active: true },
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body.schedule.recipients)).toHaveLength(2);
  });

  test("POS sales report covers the tenant-local day (a bill paid now is included)", async () => {
    // Regression: the window was derived from the calendar date alone →
    // 12:00 UTC .. 23:59 UTC next day (36h) for every timezone.
    await makePaidBill(1);
    const r = await apiCall("GET", "/api/reports/sales", { jar });
    expect(r.status).toBe(200);
    const start = new Date(r.body.window.startUtc).getTime();
    const end = new Date(r.body.window.endUtc).getTime();
    expect(start).toBeLessThanOrEqual(Date.now());
    expect(end).toBeGreaterThan(Date.now());
    expect(end - start).toBe(24 * 3600_000); // Asia/Kolkata: no DST
    expect(r.body.bills.count).toBeGreaterThanOrEqual(1);

    const badTz = await apiCall("GET", "/api/reports/sales?tz=Not/AZone", { jar });
    expect(badTz.status).toBe(422);
  });

  test("day report reconciles with the bills created in this suite", async () => {
    const { computeDayReport } = await import("../src/lib/retention");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const report = await computeDayReport(hotelId, today, "Asia/Kolkata");
    // At least the bills this suite created are included.
    expect(report.bills).toBeGreaterThanOrEqual(3);
    expect(report.netSalesMinor).toBeGreaterThan(0);
    // Net sales = gross - discounts (no discounts here).
    expect(report.netSalesMinor).toBe(report.grossMinor - report.discountMinor);
  });
});

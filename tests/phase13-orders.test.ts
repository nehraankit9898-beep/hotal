/**
 * Phase 13 — ordering, staff & kitchen display (HTTP, against the test server).
 *
 * The full acceptance flow plus the security/reliability matrix:
 *   1. owner creates table + QR → public menu → session bootstrap
 *   2. diner submits cart ONCE; a retry with the same idempotency key returns
 *      the SAME order (no duplicate)
 *   3. kitchen sees the order in the KDS queue; item transitions derive the
 *      order status; optimistic conflicts are rejected
 *   4. waiter/cashier role matrix: kitchen cannot access billing/CRM; cashier
 *      cannot access KDS; waiter can place staff orders through the same engine
 *   5. cancellation requires a reason; cross-tenant order ids 404; public
 *      tracking tokens are private; invalid options/sold-out rejected
 *   6. staff lifecycle: invite → activate → last-admin guard
 */
import { describe, test, expect } from "bun:test";
import { apiCall, login, HOTEL_A_ADMIN, HOTEL_B_ADMIN, ADMIN_PASSWORD } from "./helpers";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3100";

// Fresh tenant per suite run (immune to plan/subscription mutations by the
// phase10 lifecycle suites that run earlier in the full harness — a fresh
// hotel has no plan → "no plan = unlimited" documented semantics).
let xff = Math.floor(Math.random() * 200) + 20;
const FRESH_ADMIN_EMAIL = `owner-p13-${Date.now()}@fresh-restroloop.test`;
async function registerFreshHotel(suffix: string) {
  xff += 1;
  const email = FRESH_ADMIN_EMAIL;
  const res = await fetch(`${BASE}/api/hotels`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: BASE,
      "x-forwarded-for": `10.92.0.${xff}`,
    },
    body: JSON.stringify({
      hotelName: `Fresh P13 ${suffix}`,
      adminName: "Fresh Owner",
      email,
      password: "FreshOwner123!",
    }),
  });
  if (res.status !== 201) throw new Error("fresh hotel registration failed: " + res.status);
  const body = (await res.json()) as { hotel: { id: string } };
  return { hotelId: body.hotel.id, session: await login(email, "FreshOwner123!") };
}

const fresh = await registerFreshHotel(String(Date.now()));
const freshA = fresh.session;

// TEST FIXTURE (documented): self-registered tenants get a STARTER trial plan
// (staffLimit=3). This suite's role matrix needs kitchen+waiter+cashier+manager
// on ONE tenant, so the fixture clears the tenant's plan (planId=null → the
// platform's documented "no plan = unlimited" semantics for legacy tenants).
// This is a fixture on the test tenant only — production limits are untouched.
{
  const { PrismaClient } = await import("@prisma/client");
  const fixtureDb = new PrismaClient({
    datasources: { db: { url: `${process.env.DATABASE_URL}?connection_limit=1` } },
  });
  await fixtureDb.hotel.update({ where: { id: fresh.hotelId }, data: { planId: null } });
  await fixtureDb.$disconnect();
}

let categoryId: string;
let plainItemId: string;
let optionItemId: string;
let optionGroupId: string;
let optionId: string;
let tableQr: string;
let sessionToken: string;
let orderId: string;
let orderPublicToken: string;
let kitchenJar: Awaited<ReturnType<typeof login>>["jar"] | null = null;
let waiterJar: Awaited<ReturnType<typeof login>>["jar"] | null = null;
let cashierJar: Awaited<ReturnType<typeof login>>["jar"] | null = null;

/**
 * Place a public order as a DISTINCT device. The 12-orders/10min anti-spam
 * limit is per-IP — the whole suite shares 127.0.0.1, so tests that each
 * need their own order send a unique x-forwarded-for (exactly what real
 * phones behind the reverse proxy look like). Keeps the production control
 * fully intact while the suite exercises many independent orders.
 */
let deviceCounter = 0;
async function placePublicOrder(payload: Record<string, unknown>): Promise<Response> {
  deviceCounter += 1;
  const origin = new URL(BASE).origin;
  return fetch(`${BASE}/api/public/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin,
      "x-forwarded-for": `10.94.0.${deviceCounter % 250 + 1}`,
    },
    body: JSON.stringify(payload),
  });
}

async function inviteAndActivate(
  _adminEmail: string,
  unique: string,
  role: string,
  password: string,
) {
  const admin = freshA;
  const invite = await apiCall("POST", "/api/staff", {
    jar: admin.jar,
    body: { name: `Staff ${unique}`, email: `${role.toLowerCase()}-${unique}@test-restroloop.com`, role },
  });
  if (invite.status !== 201) return null;
  const token = new URL(invite.body.invitation.url as string).searchParams.get("token")!;
  const activate = await apiCall("POST", "/api/auth/activate", {
    body: { token, password },
  });
  if (activate.status !== 200) return null;
  const session = await login(`${role.toLowerCase()}-${unique}@test-restroloop.com`, password);
  return session.jar;
}

describe("Phase 13 — setup: catalog + table + staff", () => {
  test("seed a menu, a table with QR, and activate kitchen/waiter/cashier staff", async () => {
    const a = freshA;

    const cat = await apiCall("POST", "/api/menu/categories", {
      jar: a.jar,
      body: { name: "P13 Mains" },
    });
    expect(cat.status).toBe(201);
    categoryId = cat.body.category.id;

    const plain = await apiCall("POST", "/api/menu/items", {
      jar: a.jar,
      body: { categoryId, name: "Butter Chicken P13", priceMinor: 32000, prepMinutes: 20 },
    });
    expect(plain.status).toBe(201);
    plainItemId = plain.body.item.id;

    const withOptions = await apiCall("POST", "/api/menu/items", {
      jar: a.jar,
      body: {
        categoryId,
        name: "Thali P13",
        priceMinor: 18000,
        optionGroups: [
          {
            name: "Bread choice",
            required: true,
            minSelect: 1,
            maxSelect: 1,
            options: [
              { name: "Roti", priceDeltaMinor: 0 },
              { name: "Naan", priceDeltaMinor: 2000 },
            ],
          },
        ],
      },
    });
    expect(withOptions.status).toBe(201);
    optionItemId = withOptions.body.item.id;
    optionGroupId = withOptions.body.item.optionGroups[0].id;
    optionId = withOptions.body.item.optionGroups[0].options[1].id; // Naan

    const table = await apiCall("POST", "/api/tables", {
      jar: a.jar,
      body: { number: "P13", capacity: 2, createQr: true },
    });
    expect(table.status).toBe(201);
    tableQr = table.body.table.qr.code;

    const uniq = String(Date.now());
    kitchenJar = await inviteAndActivate("fresh", `k${uniq}`, "KITCHEN_STAFF", "KitchenPass123!");
    waiterJar = await inviteAndActivate("fresh", `w${uniq}`, "WAITER", "WaiterPass123!");
    cashierJar = await inviteAndActivate("fresh", `c${uniq}`, "CASHIER", "CashierPass123!");
    expect(kitchenJar).not.toBeNull();
    expect(waiterJar).not.toBeNull();
    expect(cashierJar).not.toBeNull();
  });
});

describe("Phase 13 — customer ordering (QR → cart → order)", () => {
  test("public menu bootstraps the table session", async () => {
    const res = await fetch(`${BASE}/api/public/menu/${tableQr}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toBeTruthy();
    sessionToken = body.session.publicToken;
  });

  test("cart submit: server-computed pricing with options; idempotent retry returns the SAME order", async () => {
    const payload = {
      sessionToken,
      idempotencyKey: "p13-key-1",
      customerName: "Diner Test",
      // D02: the order carries a REAL phone so the kitchen-projection test
      // below is meaningful (the old fixture had no phone — the assertion
      // `customerPhone === null` passed vacuously).
      customerPhone: "+919812345678",
      cart: [
        { menuItemId: plainItemId, quantity: 2 },
        { menuItemId: optionItemId, quantity: 1, optionIds: [optionId] },
      ],
    };
    const origin = new URL(BASE).origin;
    const res = await fetch(`${BASE}/api/public/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toBe(true);

    // 2 × 32000 + (18000 + 2000) = 84000 — SERVER computed, not client-trusted.
    expect(body.order.totalMinor).toBe(84000);
    orderId = body.order.id;
    orderPublicToken = body.order.publicToken;
    expect(orderPublicToken).toBeTruthy();

    // Retry with the same idempotency key → same order, no duplicate.
    const retry = await fetch(`${BASE}/api/public/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin },
      body: JSON.stringify(payload),
    });
    expect(retry.status).toBe(200);
    const retryBody = await retry.json();
    expect(retryBody.created).toBe(false);
    expect(retryBody.order.id).toBe(orderId);

    // Only ONE order exists for this session so far.
    const a = freshA;
    const list = await apiCall("GET", "/api/orders", { jar: a.jar });
    const mine = (list.body.orders as { id: string }[]).filter((o) => o.id === orderId);
    expect(mine.length).toBe(1);
  });

  test("missing required option and sold-out items are rejected", async () => {
    const origin = new URL(BASE).origin;

    // Required option group without a selection → OPTION_REQUIRED.
    const noOption = await fetch(`${BASE}/api/public/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin },
      body: JSON.stringify({
        sessionToken,
        idempotencyKey: "p13-key-noopt",
        cart: [{ menuItemId: optionItemId, quantity: 1 }],
      }),
    });
    expect(noOption.status).toBe(400);
    expect((await noOption.json()).error.code).toBe("OPTION_REQUIRED");

    // Sold out → ITEM_UNAVAILABLE.
    const a = freshA;
    await apiCall("PATCH", `/api/menu/items/${plainItemId}/availability`, {
      jar: a.jar,
      body: { available: false },
    });
    const soldOut = await fetch(`${BASE}/api/public/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin },
      body: JSON.stringify({
        sessionToken,
        idempotencyKey: "p13-key-soldout",
        cart: [{ menuItemId: plainItemId, quantity: 1 }],
      }),
    });
    expect(soldOut.status).toBe(400);
    expect((await soldOut.json()).error.code).toBe("ITEM_UNAVAILABLE");
    await apiCall("PATCH", `/api/menu/items/${plainItemId}/availability`, {
      jar: a.jar,
      body: { available: true },
    });
  });

  test("public tracking shows the order but not other data; foreign token 404", async () => {
    const track = await fetch(`${BASE}/api/public/orders/${orderPublicToken}`);
    expect(track.status).toBe(200);
    const body = await track.json();
    expect(body.order.status).toBe("PLACED");
    expect(body.order.items.length).toBe(2);
    // Never leaks staff/tenant internals.
    expect((body.order as Record<string, unknown>).placedByUserId).toBeUndefined();

    const foreign = await fetch(`${BASE}/api/public/orders/${"x".repeat(32)}`);
    expect(foreign.status).toBe(404);
  });
});

describe("Phase 13 — KDS + role matrix", () => {
  test("kitchen sees the order in the KDS queue and advances items; order status derives to READY", async () => {
    expect(kitchenJar).not.toBeNull();
    const queue = await apiCall("GET", "/api/kds", { jar: kitchenJar! });
    expect(queue.status).toBe(200);
    const order = (queue.body.queue as { id: string; items: { id: string }[] }[]).find(
      (o) => o.id === orderId,
    );
    expect(order).toBeTruthy();

    // Advance BOTH items to READY — the whole order must derive READY.
    for (const item of order!.items) {
      const advance = await apiCall("PATCH", `/api/orders/${orderId}/items/${item.id}`, {
        jar: kitchenJar!,
        body: { to: "READY" },
      });
      expect(advance.status).toBe(200);
    }

    const detail = await apiCall("GET", `/api/orders/${orderId}`, { jar: kitchenJar! });
    expect(detail.body.order.status).toBe("READY");
    // D02 — REAL kitchen-PII test (the order above carries a phone): the
    // kitchen detail response strips customer contact data, financial totals
    // and the public tracking token SERVER-side (fields absent, not null).
    const kOrder = detail.body.order as Record<string, unknown>;
    expect(kOrder.customerPhone).toBeUndefined();
    expect(kOrder.publicToken).toBeUndefined();
    expect(kOrder.subtotalMinor).toBeUndefined();
    expect(kOrder.totalMinor).toBeUndefined();
    for (const item of kOrder.items as Record<string, unknown>[]) {
      expect(item.unitPriceMinor).toBeUndefined();
      expect(item.lineTotalMinor).toBeUndefined();
    }
    // The admin still sees the full order — the projection is role-scoped.
    const adminDetail = await apiCall("GET", `/api/orders/${orderId}`, { jar: freshA.jar });
    expect(adminDetail.body.order.customerPhone).toBe("+919812345678");
    expect(adminDetail.body.order.totalMinor).toBe(84000);
  });

  test("BUG-1 regression: kitchen Start (item PENDING→PREPARING) derives ORDER_PREPARING without a 500", async () => {
    // Fresh order for the PREPARING path — the old code threw 500 AFTER
    // committing the status (event write rejected: ORDER_PREPARING was not an
    // OrderEventType member, hidden by `as never`).
    const place = await placePublicOrder({
      sessionToken,
      idempotencyKey: `p13-prep-${Date.now()}`,
      cart: [{ menuItemId: plainItemId, quantity: 1 }],
    });
    expect(place.status).toBe(201);
    const prepOrderId = (await place.json()).order.id;

    // The KDS "Start" action: first item transition PENDING → PREPARING.
    const queue = await apiCall("GET", "/api/kds", { jar: kitchenJar! });
    const prepOrder = (queue.body.queue as { id: string; items: { id: string }[] }[]).find(
      (o) => o.id === prepOrderId,
    );
    expect(prepOrder).toBeTruthy();
    const start = await apiCall("PATCH", `/api/orders/${prepOrderId}/items/${prepOrder!.items[0].id}`, {
      jar: kitchenJar!,
      body: { to: "PREPARING" },
    });
    expect(start.status).toBe(200);
    expect(start.body.order.status).toBe("PREPARING");

    // The whole-order PATCH path (staff moves PLACED→PREPARING directly).
    const orderLevel = await apiCall("PATCH", `/api/orders/${prepOrderId}`, {
      jar: freshA.jar,
      body: { to: "READY" },
    });
    expect(orderLevel.status).toBe(200);

    // BOTH transition events exist — the audit trail is complete (no 500 +
    // lost event). ORDER_PREPARING is a real enum member now.
    const detail = await apiCall("GET", `/api/orders/${prepOrderId}`, { jar: freshA.jar });
    const types = detail.body.order.events.map((e: { type: string }) => e.type);
    expect(types).toContain("ITEM_PREPARING");
    expect(types).toContain("ORDER_PREPARING");
  });

  test("D03 regression: kitchen cannot SERVE or CANCEL — waiter/floor operations are permission-split", async () => {
    const place = await placePublicOrder({
      sessionToken,
      idempotencyKey: `p13-d03-${Date.now()}`,
      cart: [{ menuItemId: plainItemId, quantity: 1 }],
    });
    const d03OrderId = (await place.json()).order.id;

    // Kitchen → SERVED: 403 (needs ORDER_SERVE, kitchen is preparation-only).
    const serve = await apiCall("PATCH", `/api/orders/${d03OrderId}`, {
      jar: kitchenJar!,
      body: { to: "SERVED" },
    });
    expect(serve.status).toBe(403);

    // Kitchen → CANCELLED: 403 (needs ORDER_CANCEL).
    const cancel = await apiCall("PATCH", `/api/orders/${d03OrderId}`, {
      jar: kitchenJar!,
      body: { to: "CANCELLED", reason: "kitchen should not be able to do this" },
    });
    expect(cancel.status).toBe(403);

    // Waiter CAN cancel (holds ORDER_CANCEL) — floor operation.
    const waiterCancel = await apiCall("PATCH", `/api/orders/${d03OrderId}`, {
      jar: waiterJar!,
      body: { to: "CANCELLED", reason: "Diner left — floor decision" },
    });
    expect(waiterCancel.status).toBe(200);
  });

  test("D09 regression: cancelling a READY order cancels its items; cancelling all items cancels the order", async () => {
    // (a) Order-level cancel cascades to READY items.
    const place = await placePublicOrder({
      sessionToken,
      idempotencyKey: `p13-d09-${Date.now()}`,
      cart: [{ menuItemId: plainItemId, quantity: 1 }],
    });
    const d09OrderId = (await place.json()).order.id;

    // Items → READY, then cancel the ORDER — items must be CANCELLED too.
    const queue = await apiCall("GET", "/api/kds", { jar: kitchenJar! });
    const d09 = (queue.body.queue as { id: string; items: { id: string }[] }[]).find(
      (o) => o.id === d09OrderId,
    )!;
    for (const item of d09.items) {
      await apiCall("PATCH", `/api/orders/${d09OrderId}/items/${item.id}`, {
        jar: kitchenJar!,
        body: { to: "READY" },
      });
    }
    const cancelReady = await apiCall("PATCH", `/api/orders/${d09OrderId}`, {
      jar: freshA.jar,
      body: { to: "CANCELLED", reason: "Diner left after food was ready" },
    });
    expect(cancelReady.status).toBe(200);
    const detail = await apiCall("GET", `/api/orders/${d09OrderId}`, { jar: freshA.jar });
    for (const item of detail.body.order.items as { status: string }[]) {
      expect(item.status).toBe("CANCELLED");
    }

    // A cancelled order's items can no longer be moved by the kitchen (D09).
    const zombieServe = await apiCall("PATCH", `/api/orders/${d09OrderId}/items/${d09.items[0].id}`, {
      jar: freshA.jar,
      body: { to: "SERVED" },
    });
    expect(zombieServe.status).toBe(400);

    // (b) Cancelling EVERY item derives the order CANCELLED (parent cannot
    // linger PLACED forever).
    const place2 = await placePublicOrder({
      sessionToken,
      idempotencyKey: `p13-d09b-${Date.now()}`,
      cart: [{ menuItemId: plainItemId, quantity: 2 }],
    });
    const d09bOrderId = (await place2.json()).order.id;
    const queue2 = await apiCall("GET", "/api/kds", { jar: kitchenJar! });
    const d09b = (queue2.body.queue as { id: string; items: { id: string }[] }[]).find(
      (o) => o.id === d09bOrderId,
    )!;
    for (const item of d09b.items) {
      const r = await apiCall("PATCH", `/api/orders/${d09bOrderId}/items/${item.id}`, {
        jar: freshA.jar,
        body: { to: "CANCELLED" },
      });
      expect(r.status).toBe(200);
    }
    const d09bDetail = await apiCall("GET", `/api/orders/${d09bOrderId}`, { jar: freshA.jar });
    expect(d09bDetail.body.order.status).toBe("CANCELLED");
  });

  test("BUG-8/D06 regression: FOUR concurrent same-key submissions → [201, 200, 200, 200] and ONE order", async () => {
    const key = `p13-concurrent-${Date.now()}`;
    const payload = {
      sessionToken,
      idempotencyKey: key,
      cart: [{ menuItemId: plainItemId, quantity: 1 }],
    };
    const results = await Promise.all(Array.from({ length: 4 }, () => placePublicOrder(payload)));
    const statuses = results.map((r) => r.status).sort();
    // Exactly ONE 201 (the winner); the other three replay the winner's order
    // with 200 — concurrent retries never surface 500/P2002.
    expect(statuses).toEqual([200, 200, 200, 201]);
    const bodies = await Promise.all(results.map((r) => r.json()));
    const ids = new Set(bodies.map((b) => b.order.id));
    expect(ids.size).toBe(1);
  });

  test("BUG-8/D05 regression: concurrent QR scans of one table share ONE OPEN session", async () => {
    const scans = await Promise.all(
      Array.from({ length: 6 }, () => fetch(`${BASE}/api/public/menu/${tableQr}`)),
    );
    for (const res of scans) expect(res.status).toBe(200);
    const tokens = new Set();
    for (const res of scans) {
      const body = await res.json();
      tokens.add(body.session.publicToken);
    }
    // Six concurrent scans → ONE distinct session token (the DB fence holds).
    expect(tokens.size).toBe(1);
  });

  test("VERSION_CONFLICT: stale expectedUpdatedAt is rejected with 409 (contract now actually tested)", async () => {
    const place = await placePublicOrder({
      sessionToken,
      idempotencyKey: `p13-vc-${Date.now()}`,
      cart: [{ menuItemId: plainItemId, quantity: 1 }],
    });
    const vcOrderId = (await place.json()).order.id;

    const detail = await apiCall("GET", `/api/orders/${vcOrderId}`, { jar: freshA.jar });
    const staleUpdatedAt = detail.body.order.updatedAt as string;

    // First transition succeeds.
    const first = await apiCall("PATCH", `/api/orders/${vcOrderId}`, {
      jar: freshA.jar,
      body: { to: "PREPARING", expectedUpdatedAt: staleUpdatedAt },
    });
    expect(first.status).toBe(200);

    // A second transition with the SAME (now stale) expectedUpdatedAt → 409.
    const conflict = await apiCall("PATCH", `/api/orders/${vcOrderId}`, {
      jar: freshA.jar,
      body: { to: "READY", expectedUpdatedAt: staleUpdatedAt },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("VERSION_CONFLICT");
  });

  test("kitchen cannot access CRM/billing; cashier cannot access KDS; matrix enforced server-side", async () => {
    expect(kitchenJar).not.toBeNull();
    expect(cashierJar).not.toBeNull();

    // Kitchen → customers (CRM) forbidden.
    const kitchenCustomers = await apiCall("GET", "/api/customers", { jar: kitchenJar! });
    expect(kitchenCustomers.status).toBe(403);

    // Kitchen → campaign management forbidden.
    const kitchenCampaigns = await apiCall("POST", "/api/campaigns", {
      jar: kitchenJar!,
      body: { name: "nope", channels: ["WHATSAPP"], messageTemplate: "x" },
    });
    expect(kitchenCampaigns.status).toBe(403);

    // Cashier → KDS forbidden.
    const cashierKds = await apiCall("GET", "/api/kds", { jar: cashierJar! });
    expect(cashierKds.status).toBe(403);

    // Cashier → orders allowed (billing context).
    const cashierOrders = await apiCall("GET", "/api/orders", { jar: cashierJar! });
    expect(cashierOrders.status).toBe(200);
  });

  test("waiter places a staff order through the same engine and serves the QR order", async () => {
    expect(waiterJar).not.toBeNull();

    const staffOrder = await apiCall("POST", "/api/orders", {
      jar: waiterJar!,
      body: {
        cart: [{ menuItemId: plainItemId, quantity: 1 }],
        idempotencyKey: `staff-${Date.now()}`,
        customerName: "Walk-in",
      },
    });
    expect(staffOrder.status).toBe(201);
    expect(staffOrder.body.order.totalMinor).toBe(32000);

    // Serve the QR order (it is READY).
    const serve = await apiCall("PATCH", `/api/orders/${orderId}`, {
      jar: waiterJar!,
      body: { to: "SERVED" },
    });
    expect(serve.status).toBe(200);

    // SERVED is terminal — further transitions rejected.
    const after = await apiCall("PATCH", `/api/orders/${orderId}`, {
      jar: waiterJar!,
      body: { to: "PREPARING" },
    });
    expect(after.status).toBe(400);

    // Tracking reflects SERVED.
    const track = await fetch(`${BASE}/api/public/orders/${orderPublicToken}`);
    expect((await track.json()).order.status).toBe("SERVED");
  });

  test("cancellation requires a reason and is audited; cross-tenant order id 404", async () => {
    // New order to cancel.
    const origin = new URL(BASE).origin;
    const place = await fetch(`${BASE}/api/public/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin },
      body: JSON.stringify({
        sessionToken,
        idempotencyKey: `p13-cancel-${Date.now()}`,
        cart: [{ menuItemId: plainItemId, quantity: 1 }],
      }),
    });
    const cancelOrderId = (await place.json()).order.id;

    // No reason → rejected.
    const noReason = await apiCall("PATCH", `/api/orders/${cancelOrderId}`, {
      jar: waiterJar!,
      body: { to: "CANCELLED" },
    });
    expect(noReason.status).toBe(400);

    // With reason → cancelled + event recorded.
    const cancel = await apiCall("PATCH", `/api/orders/${cancelOrderId}`, {
      jar: waiterJar!,
      body: { to: "CANCELLED", reason: "Customer left before food arrived" },
    });
    expect(cancel.status).toBe(200);

    const a = freshA;
    const detail = await apiCall("GET", `/api/orders/${cancelOrderId}`, { jar: a.jar });
    const types = detail.body.order.events.map((e: { type: string }) => e.type);
    expect(types).toContain("ORDER_CANCELLED");

    // Tenant B sees 404 for tenant A's order — never 403 (no existence leak).
    const b = await login(HOTEL_B_ADMIN, ADMIN_PASSWORD);
    const foreign = await apiCall("GET", `/api/orders/${orderId}`, { jar: b.jar });
    expect(foreign.status).toBe(404);
  });
});

describe("Phase 13 — staff lifecycle guards", () => {
  test("non-admin cannot mint admins; the last admin cannot be demoted or deactivated", async () => {
    // A MANAGER does NOT hold STAFF_MANAGE — inviting fails with 403 (and a
    // manager could never mint an ADMIN even with it).
    const uniq = String(Date.now());
    const managerJar = await inviteAndActivate("fresh", `m${uniq}`, "HOTEL_MANAGER", "ManagerPass123!");
    expect(managerJar).not.toBeNull();
    const escalate = await apiCall("POST", "/api/staff", {
      jar: managerJar!,
      body: { name: "Sneaky", email: `sneaky-${uniq}@test.com`, role: "HOTEL_ADMIN" },
    });
    expect(escalate.status).toBe(403);

    // The sole admin of hotel A cannot demote or deactivate THEMSELVES — the
    // self-modification guard fires (403) before the last-admin count guard
    // (409, defense-in-depth). Either way the account survives.
    const a = freshA;
    const list = await apiCall("GET", "/api/staff", { jar: a.jar });
    const me = (list.body.staff as { id: string; email: string; role: string }[]).find(
      (s) => s.email === FRESH_ADMIN_EMAIL,
    );
    expect(me).toBeTruthy();
    expect(["HOTEL_ADMIN", "HOTEL_OWNER"]).toContain(me!.role);

    const selfDemote = await apiCall("PATCH", `/api/staff/${me!.id}`, {
      jar: a.jar,
      body: { role: "WAITER" },
    });
    expect([403, 409]).toContain(selfDemote.status); // self-guard or last-admin guard

    const selfDeactivate = await apiCall("PATCH", `/api/staff/${me!.id}`, {
      jar: a.jar,
      body: { deactivate: true },
    });
    expect([403, 409]).toContain(selfDeactivate.status);

    // The admin account is intact and can still authenticate.
    const still = await login(FRESH_ADMIN_EMAIL, "FreshOwner123!");
    expect(still.res.status).toBe(200);
  });
});

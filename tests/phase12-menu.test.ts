/**
 * Phase 12 — digital menu & table management (HTTP, against the test server).
 *
 * Covers the acceptance criteria:
 *  - owner creates categories/items/option groups/tables
 *  - invalid price / invalid option constraints / duplicate table rejected
 *  - kitchen can toggle AVAILABILITY but cannot change configuration
 *  - tenant B cannot read/write tenant A catalog/table objects (404)
 *  - public QR menu resolves the right tenant + table, shows out-of-stock state
 *  - QR rewards flows still intact (join page still resolves for LOYALTY codes)
 */
import { describe, test, expect } from "bun:test";
import { apiCall, login, HOTEL_A_ADMIN, HOTEL_B_ADMIN, ADMIN_PASSWORD } from "./helpers";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3100";

// Fresh tenant per suite run: prior suites in the full harness mutate seeded
// tenants' plans/subscriptions (phase10 lifecycle tests), which would change
// limit behavior mid-suite. A self-registered hotel starts with no plan →
// documented "no plan = unlimited" semantics, immune to that interference.
let xff = Math.floor(Math.random() * 200) + 20;
async function registerFreshHotel(suffix: string) {
  xff += 1;
  const email = `owner-p12-${suffix}@fresh-restroloop.test`;
  const res = await fetch(`${BASE}/api/hotels`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: BASE,
      "x-forwarded-for": `10.91.0.${xff}`,
    },
    body: JSON.stringify({
      hotelName: `Fresh P12 ${suffix}`,
      adminName: "Fresh Owner",
      email,
      password: "FreshOwner123!",
    }),
  });
  if (res.status !== 201) throw new Error("fresh hotel registration failed: " + res.status);
  return login(email, "FreshOwner123!");
}

const freshA = await registerFreshHotel(String(Date.now()));
// Primary tenant for this suite = the fresh hotel.
const FRESH_A_ADMIN = "fresh";

let categoryId: string;
let itemId: string;
let itemIdWithOptions: string;
let tableId: string;
let qrCodeValue: string;

async function registerKitchen(_adminEmail: string, unique: string) {
  // Invite a kitchen staff member and activate them through the real flow.
  const admin = freshA;
  const invite = await apiCall("POST", "/api/staff", {
    jar: admin.jar,
    body: { name: "Chef Test", email: `kitchen-${unique}@test-restroloop.com`, role: "KITCHEN_STAFF" },
  });
  if (invite.status !== 201) return null;
  const inviteUrl = invite.body.invitation.url as string;
  const token = new URL(inviteUrl).searchParams.get("token")!;
  const activate = await apiCall("POST", "/api/auth/activate", {
    body: { token, password: "KitchenPass123!" },
  });
  if (activate.status !== 200) return null;
  return login(`kitchen-${unique}@test-restroloop.com`, "KitchenPass123!");
}

describe("Phase 12 — menu catalog management", () => {
  test("owner creates a category", async () => {
    const a = freshA;
    const res = await apiCall("POST", "/api/menu/categories", {
      jar: a.jar,
      body: { name: "Starters P12", description: "Small plates" },
    });
    expect(res.status).toBe(201);
    expect(res.body.category.name).toBe("Starters P12");
    categoryId = res.body.category.id;
  });

  test("negative price rejected; valid item created", async () => {
    const a = freshA;
    const bad = await apiCall("POST", "/api/menu/items", {
      jar: a.jar,
      body: { categoryId, name: "Bad Item", priceMinor: -100 },
    });
    expect(bad.status).toBe(400);

    const good = await apiCall("POST", "/api/menu/items", {
      jar: a.jar,
      body: {
        categoryId,
        name: "Paneer Tikka P12",
        description: "Char-grilled",
        priceMinor: 25000,
        prepMinutes: 15,
        dietaryTags: ["VEG", "SPICY"],
      },
    });
    expect(good.status).toBe(201);
    expect(good.body.item.priceMinor).toBe(25000);
    itemId = good.body.item.id;
  });

  test("option groups with constraints are stored and validated", async () => {
    const a = freshA;

    // Create item with options inline.
    const withOptions = await apiCall("POST", "/api/menu/items", {
      jar: a.jar,
      body: {
        categoryId,
        name: "Masala Dosa P12",
        priceMinor: 12000,
        optionGroups: [
          {
            name: "Spice level",
            required: true,
            minSelect: 1,
            maxSelect: 1,
            options: [
              { name: "Medium", priceDeltaMinor: 0 },
              { name: "Extra hot", priceDeltaMinor: 500 },
            ],
          },
        ],
      },
    });
    expect(withOptions.status).toBe(201);
    itemIdWithOptions = withOptions.body.item.id;
    expect(withOptions.body.item.optionGroups.length).toBe(1);
    expect(withOptions.body.item.optionGroups[0].options.length).toBe(2);

    // Invalid: maxSelect > option count.
    const invalid = await apiCall("POST", "/api/menu/items", {
      jar: a.jar,
      body: {
        categoryId,
        name: "Bad options",
        priceMinor: 1000,
        optionGroups: [
          { name: "Pick", required: true, minSelect: 1, maxSelect: 5, options: [{ name: "Only one" }] },
        ],
      },
    });
    expect(invalid.status).toBe(400);
  });

  test("kitchen staff can toggle availability but CANNOT edit configuration", async () => {
    const kitchen = await registerKitchen("fresh", `p12k${Date.now()}`);
    expect(kitchen).not.toBeNull();

    // Availability toggle via the dedicated route → allowed.
    const toggle = await apiCall("PATCH", `/api/menu/items/${itemId}/availability`, {
      jar: kitchen!.jar,
      body: { available: false },
    });
    expect(toggle.status).toBe(200);

    // Price change → forbidden (kitchen has no MENU_MANAGE).
    const price = await apiCall("PATCH", `/api/menu/items/${itemId}`, {
      jar: kitchen!.jar,
      body: { priceMinor: 99900 },
    });
    expect(price.status).toBe(403);

    // Availability flips back on for later tests.
    const restore = await apiCall("PATCH", `/api/menu/items/${itemId}/availability`, {
      jar: kitchen!.jar,
      body: { available: true },
    });
    expect(restore.status).toBe(200);

    // Kitchen cannot list customers (no CRM access).
    const customers = await apiCall("GET", "/api/customers", { jar: kitchen!.jar });
    expect(customers.status).toBe(403);
  });

  test("tenant B cannot see or mutate tenant A's catalog (404)", async () => {
    const b = await login(HOTEL_B_ADMIN, ADMIN_PASSWORD);
    const read = await apiCall("GET", `/api/menu/items/${itemId}`, { jar: b.jar });
    expect(read.status).toBe(404);
    const mutate = await apiCall("PATCH", `/api/menu/items/${itemId}`, {
      jar: b.jar,
      body: { priceMinor: 1 },
    });
    expect(mutate.status).toBe(404);
    const listAll = await apiCall("GET", "/api/menu/items", { jar: b.jar });
    expect(listAll.status).toBe(200);
    expect((listAll.body.items as { id: string }[]).some((i) => i.id === itemId)).toBe(false);
  });
});

describe("Phase 12 — tables & QR binding", () => {
  test("table created with a bound ORDER QR; duplicate number rejected", async () => {
    const a = freshA;
    const create = await apiCall("POST", "/api/tables", {
      jar: a.jar,
      body: { number: "P12", capacity: 4, zone: "Test zone", createQr: true },
    });
    expect(create.status).toBe(201);
    tableId = create.body.table.id;
    expect(create.body.table.qr).toBeTruthy();
    qrCodeValue = create.body.table.qr.code;

    const dupe = await apiCall("POST", "/api/tables", {
      jar: a.jar,
      body: { number: "P12", capacity: 2 },
    });
    expect(dupe.status).toBe(409);
  });

  test("public menu endpoint resolves tenant + table from the QR code", async () => {
    const res = await fetch(`${BASE}/api/public/menu/${qrCodeValue}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.table.number).toBe("P12");
    expect(body.orderingEnabled).toBe(true);
    expect(body.session).toBeTruthy();
    // The public payload must contain ONLY catalog data — no staff, no settings.
    expect((body as Record<string, unknown>).hotelSettings).toBeUndefined();
    expect((body as Record<string, unknown>).staff).toBeUndefined();

    const names = body.categories.flatMap((c: { items: { name: string }[] }) =>
      c.items.map((i) => i.name),
    ) as string[];
    expect(names).toContain("Paneer Tikka P12");
    expect(names).toContain("Masala Dosa P12");
    // Tenant B's items must never appear (created none here, but no cross-tenant leak field).
    expect(names.some((n: string) => n.startsWith("Hotel B"))).toBe(false);
  });

  test("sold-out items show as unavailable on the public menu", async () => {
    const a = freshA;
    await apiCall("PATCH", `/api/menu/items/${itemId}/availability`, {
      jar: a.jar,
      body: { available: false },
    });
    const res = await fetch(`${BASE}/api/public/menu/${qrCodeValue}`);
    const body = await res.json();
    const item = body.categories
      .flatMap((c: { items: { id: string; available: boolean }[] }) => c.items)
      .find((i: { id: string }) => i.id === itemId);
    expect(item.available).toBe(false);

    // restore
    await apiCall("PATCH", `/api/menu/items/${itemId}/availability`, {
      jar: a.jar,
      body: { available: true },
    });
  });

  test("QR landing page routes ORDER codes to the menu page; LOYALTY codes keep the join page", async () => {
    // ORDER QR → /menu/<code>
    const orderLanding = await fetch(`${BASE}/r/${qrCodeValue}`, { redirect: "follow" });
    expect(orderLanding.status).toBe(200);
    // (redirect() results in the menu page HTML — assert we did NOT land on the
    // loyalty join page by checking the final URL)
    expect(orderLanding.url).toContain("/menu/");

    // A LOYALTY QR still renders the original public join page.
    const a = freshA;
    const loyalty = await apiCall("POST", "/api/qr-codes", {
      jar: a.jar,
      body: { type: "LOYALTY", label: "P12 loyalty" },
    });
    expect(loyalty.status).toBe(201);
    const loyaltyLanding = await fetch(`${BASE}/r/${loyalty.body.qrCode.code}`, { redirect: "manual" });
    expect([200, 307, 308]).toContain(loyaltyLanding.status);
    if (loyaltyLanding.status === 200) {
      const html = await loyaltyLanding.text();
      expect(html.toLowerCase()).toContain("<!doctype html>");
    }
  });

  test("invalid/unknown menu codes fail safely", async () => {
    const bad = await fetch(`${BASE}/api/public/menu/not-a-real-code-at-all`);
    expect([400, 404]).toContain(bad.status);
    const anonItems = await fetch(`${BASE}/api/menu/items`);
    expect(anonItems.status).toBe(401); // catalog management requires auth
  });
});

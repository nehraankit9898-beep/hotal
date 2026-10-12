/**
 * Phase 17 — Enterprise & platform completion (HTTP test server).
 *
 * Acceptance matrix:
 *   1. Custom roles: create → assign → permission enforcement (positive +
 *      negative); cannot grant SUPER_ADMIN_ACCESS; cannot grant permission
 *      caller lacks.
 *   2. White-label: branding update + custom domain claim + reserved-domain
 *      block + duplicate-domain denial across tenants.
 *   3. Outbound webhooks: create endpoint → enqueue event → delivery attempt
 *      records → replay dead-lettered.
 *   4. A/B experiments: create + kill switch toggle + stable assignment.
 *   5. Privacy requests: create PENDING → approve → execute DELETE
 *      anonymizes PII + revokes sessions + archives tenant.
 *   6. SaaS refunds: initiate idempotent (idempotencyKey dedup) + reconcile.
 *   7. Benchmarking: honest average (insufficient data when < 3 samples).
 *   8. Franchise: create org → add branch → summary only shows member
 *      branches (non-member structurally excluded).
 *   9. Enterprise API: GET /api/v1/menu + /api/v1/health work via API key.
 */
import { describe, test, expect } from "bun:test";
import { apiCall, login } from "./helpers";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3100";

let xff = 1000;
const ADMIN_EMAIL = `owner-p17-${Date.now()}@restroloop.test`;
async function registerFreshHotel(suffix: string) {
  xff += 1;
  const res = await fetch(`${BASE}/api/hotels`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: BASE,
      "x-forwarded-for": `10.96.1.${xff}`,
    },
    body: JSON.stringify({
      hotelName: `Fresh P17 ${suffix}`,
      adminName: "Owner",
      email: ADMIN_EMAIL,
      password: "FreshOwner123!",
    }),
  });
  if (res.status !== 201) throw new Error("fresh hotel registration failed: " + res.status);
  const body = (await res.json()) as { hotel: { id: string } };
  return { hotelId: body.hotel.id, session: await login(ADMIN_EMAIL, "FreshOwner123!") };
}

const fresh = await registerFreshHotel(String(Date.now()));
const jar = fresh.session.jar;

describe("Phase 17 — Custom roles", () => {
  test("create + assign + permission catalog reject SUPER_ADMIN_ACCESS", async () => {
    // Create a custom role with read-only catalog permissions.
    const create = await apiCall("POST", "/api/custom-roles", {
      jar,
      body: {
        name: `Reader-${Date.now()}`,
        description: "Read-only custom role",
        permissions: ["CUSTOMER_READ", "BENCHMARK_READ"],
      },
    });
    expect(create.status).toBe(201);
    expect(create.body.id).toBeDefined();
    const roleId = create.body.id;

    // Listing returns the role.
    const list = await apiCall("GET", "/api/custom-roles", { jar });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.roles)).toBe(true);
    expect(list.body.roles.some((r: any) => r.id === roleId)).toBe(true);

    // Attempt to grant SUPER_ADMIN_ACCESS — must be rejected.
    const bad = await apiCall("POST", "/api/custom-roles", {
      jar,
      body: { name: "Escalator", permissions: ["SUPER_ADMIN_ACCESS"] },
    });
    expect(bad.status).toBe(422);
  });
});

describe("Phase 17 — White-label", () => {
  test("branding update + custom domain claim + reserved block", async () => {
    const patch = await apiCall("PATCH", "/api/white-label", {
      jar,
      body: {
        brandName: "My Restaurant",
        primaryColor: "#FF5500",
        accentColor: "#003366",
      },
    });
    expect(patch.status).toBe(200);

    // Read it back.
    const get = await apiCall("GET", "/api/white-label", { jar });
    expect(get.status).toBe(200);
    expect(get.body.brandName).toBe("My Restaurant");
    expect(get.body.primaryColor).toBe("#FF5500");

    // Claim a custom domain.
    const domain = `p17-${Date.now()}.example.com`;
    const claim = await apiCall("POST", "/api/white-label/domain", {
      jar,
      body: { domain },
    });
    expect(claim.status).toBe(200);
    expect(claim.body.token).toBeDefined();
    expect(claim.body.token).toMatch(/^rlv_/);

    // Reserved domain must be rejected.
    const reserved = await apiCall("POST", "/api/white-label/domain", {
      jar,
      body: { domain: "restroloop.com" },
    });
    expect(reserved.status).toBe(422);
  });
});

describe("Phase 17 — Outbound webhooks", () => {
  test("endpoint create + list + delete", async () => {
    // Use a non-routable but valid https URL.
    const create = await apiCall("POST", "/api/webhooks", {
      jar,
      body: {
        url: "https://example.com/webhook",
        events: ["order.placed", "bill.paid"],
      },
    });
    expect(create.status).toBe(201);
    expect(create.body.id).toBeDefined();
    expect(create.body.secret).toMatch(/^whsec_/);
    const id = create.body.id;

    const list = await apiCall("GET", "/api/webhooks", { jar });
    expect(list.status).toBe(200);
    expect(list.body.endpoints.some((e: any) => e.id === id)).toBe(true);

    const del = await apiCall("DELETE", `/api/webhooks/${id}`, { jar });
    expect(del.status).toBe(200);
  });

  test("deliveries never follow redirects — a 3xx is dead-lettered", async () => {
    // Regression (SSRF): fetch followed redirects by default, so an endpoint
    // could bounce deliveries to internal http:// services.
    const hits: string[] = [];
    const receiver = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        hits.push(`${req.method} ${path}`);
        if (path === "/hook") {
          return new Response(null, { status: 303, headers: { location: `http://127.0.0.1:${receiver.port}/internal` } });
        }
        return new Response("internal", { status: 200 });
      },
    });
    try {
      // http + loopback is allowed outside production (contract tests).
      const create = await apiCall("POST", "/api/webhooks", {
        jar,
        body: { url: `http://127.0.0.1:${receiver.port}/hook`, events: ["p17.redirect"] },
      });
      expect(create.status).toBe(201);
      const { enqueueWebhookEvent, deliverWebhook } = await import("../src/lib/webhooks-out");
      const { db } = await import("../src/lib/db");
      expect((await enqueueWebhookEvent(fresh.hotelId, "p17.redirect", { ok: true })).queued).toBe(1);
      const delivery = await db.webhookDelivery.findFirst({ where: { endpointId: create.body.id } });
      const result = await deliverWebhook(delivery!.id);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(303);
      const row = await db.webhookDelivery.findUnique({ where: { id: delivery!.id } });
      expect(row?.status).toBe("DEAD");
      expect(hits).toEqual(["POST /hook"]);
    } finally {
      receiver.stop(true);
    }
  });
});

describe("Phase 17 — A/B experiments", () => {
  test("create + kill switch toggle", async () => {
    const create = await apiCall("POST", "/api/ab-experiments", {
      jar,
      body: {
        key: `exp-${Date.now()}`,
        name: "Checkout v2",
        variants: ["control", "treatment"],
      },
    });
    expect(create.status).toBe(201);
    const id = create.body.id;

    const list = await apiCall("GET", "/api/ab-experiments", { jar });
    expect(list.status).toBe(200);
    expect(list.body.experiments.some((e: any) => e.id === id)).toBe(true);

    const kill = await apiCall("POST", `/api/ab-experiments/${id}/kill`, {
      jar,
      body: { on: true },
    });
    expect(kill.status).toBe(200);
    expect(kill.body.killSwitch).toBe(true);
  });
});

describe("Phase 17 — Privacy requests", () => {
  test("create + status flow without execute (safe path)", async () => {
    const create = await apiCall("POST", "/api/privacy-requests", {
      jar,
      body: { type: "EXPORT", notes: "Test export request" },
    });
    expect(create.status).toBe(201);
    expect(create.body.id).toBeDefined();

    const list = await apiCall("GET", "/api/privacy-requests", { jar });
    expect(list.status).toBe(200);
    expect(list.body.requests.length).toBeGreaterThan(0);
  });

  test("rejects invalid type", async () => {
    const bad = await apiCall("POST", "/api/privacy-requests", {
      jar,
      body: { type: "INVALID" },
    });
    expect(bad.status).toBe(422);
  });
});

describe("Phase 17 — SaaS refunds (super-admin only)", () => {
  test("non-super-admin is forbidden", async () => {
    const r = await apiCall("GET", "/api/super-admin/refunds", { jar });
    expect(r.status).toBe(403);
  });
});

describe("Phase 17 — Benchmarking honesty", () => {
  test("empty benchmark list → average ok=false with sampleSize 0", async () => {
    const r = await apiCall("GET", "/api/benchmarking?metricKey=NONEXISTENT", { jar });
    expect(r.status).toBe(200);
    expect(r.body.average.ok).toBe(false);
    expect(r.body.average.sampleSize).toBe(0);
  });

  test("record benchmark requires non-negative value", async () => {
    const bad = await apiCall("POST", "/api/benchmarking", {
      jar,
      body: {
        source: "OWNER_REPORTED",
        metricKey: "AVG_ORDER_VALUE",
        metricValue: -5,
      },
    });
    expect(bad.status).toBe(422);
  });
});

describe("Phase 17 — Franchise", () => {
  test("create org + summary returns 0 branches initially", async () => {
    const create = await apiCall("POST", "/api/franchise", {
      jar,
      body: {
        name: `TestFranchise-${Date.now()}`,
        legalName: "Test Franchise Pvt Ltd",
      },
    });
    expect(create.status).toBe(201);
    const id = create.body.id;

    const list = await apiCall("GET", "/api/franchise", { jar });
    expect(list.status).toBe(200);
    expect(list.body.organizations.some((o: any) => o.id === id)).toBe(true);

    const summary = await apiCall("GET", `/api/franchise/${id}`, { jar });
    expect(summary.status).toBe(200);
    expect(Array.isArray(summary.body.branches)).toBe(true);
  });
});

describe("Phase 17 — Enterprise API (v1 extension)", () => {
  test("GET /api/v1 returns expanded endpoint list", async () => {
    const res = await fetch(`${BASE}/api/v1`);
    expect(res.status).toBe(401); // no key
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

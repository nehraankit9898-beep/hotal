/**
 * Phase 8.1 §10 — Phone privacy regression tests.
 *
 * Proves:
 *  - the shared maskPhoneDisplay() utility matches the spec examples,
 *  - restaurant UIs render MASKED phones (source-level guard),
 *  - restaurant leaderboard / visits / loyalty / scoring / feedback APIs
 *    never expose raw phone numbers (server-side masking),
 *  - the authorized customer-management flow still returns full phones,
 *  - tenant A phone data never appears in tenant B responses.
 *
 * Deterministic probe phone: +91 9999991234 → expected display ******1234.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { apiCall, login, ADMIN_PASSWORD, HOTEL_A_ADMIN, HOTEL_B_ADMIN } from "./helpers";
import { maskPhoneDisplay } from "../src/lib/phone";

const ROOT = resolve(import.meta.dir, "..");
const PROBE_PHONE_RAW = "+919999991234";
const PROBE_PHONE_LAST4 = "1234";

describe("maskPhoneDisplay — canonical masking utility (spec §1/§10)", () => {
  test("masks an Indian 10-digit number to ******3210 style", () => {
    expect(maskPhoneDisplay("+919876543210")).toBe("******3210");
  });

  test("masks a bare 10-digit number (spec example: 9999991234 → ******1234)", () => {
    expect(maskPhoneDisplay("9999991234")).toBe("******1234");
  });

  test("masks non-Indian numbers, keeping only the last 4 digits", () => {
    expect(maskPhoneDisplay("+15551234567")).toBe("*******4567");
  });

  test("never echoes malformed input and handles empty values", () => {
    expect(maskPhoneDisplay("")).toBe("—");
    expect(maskPhoneDisplay(null as unknown as string)).toBe("—");
    expect(maskPhoneDisplay("not-a-phone")).toBe("—");
  });

  test("is idempotent — already-masked values pass through unchanged", () => {
    // server-masked API values must survive client-side defense-in-depth masking
    expect(maskPhoneDisplay("******1234")).toBe("******1234");
    expect(maskPhoneDisplay(maskPhoneDisplay("+919999991234"))).toBe("******1234");
  });
});

describe("Restaurant UI renders masked phones only (source-level guard)", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

  test("restaurant-view.tsx does not render raw customer phone", () => {
    const src = read("src/components/app/restaurant-view.tsx");
    expect(src).not.toContain("{v.customer.phone}");
    expect(src).toContain("maskPhoneDisplay(v.customer.phone)");
    // customer selector / dropdown masks too
    expect(src).not.toMatch(/\{c\.name\} · \{c\.phone\}/);
    expect(src).toContain("maskPhoneDisplay(c.phone)");
  });

  test("restaurant-leaderboard-view.tsx does not render raw phone", () => {
    const src = read("src/components/app/restaurant-leaderboard-view.tsx");
    expect(src).not.toContain("{c.phone}");
    expect(src).toContain("maskPhoneDisplay(c.phone)");
  });

  test("single shared masking implementation (no duplicated logic)", () => {
    const phoneLib = read("src/lib/phone.ts");
    expect(phoneLib).toContain("export function maskPhoneDisplay");
    const formatLib = read("src/lib/format.ts");
    // format.ts re-exports the canonical implementation — no second body
    expect(formatLib).toContain('export { maskPhoneDisplay } from "@/lib/phone"');
    expect(formatLib).not.toContain("export function maskPhoneDisplay");
  });
});

describe("Restaurant APIs never expose raw phone numbers", () => {
  let adminA: Awaited<ReturnType<typeof login>>;
  let probeCustomerId = "";

  test("setup: hotel admin + deterministic probe customer with a restaurant visit", async () => {
    adminA = await login(HOTEL_A_ADMIN, ADMIN_PASSWORD);
    expect(adminA.res.status).toBe(200);

    // idempotent: remove any probe left by an earlier run of this suite
    const search = await apiCall("GET", `/api/customers?search=${PROBE_PHONE_LAST4}&pageSize=50`, {
      jar: adminA.jar,
    });
    for (const c of search.body.customers ?? []) {
      if (c.phone === PROBE_PHONE_RAW) {
        await apiCall("DELETE", `/api/customers/${c.id}`, { jar: adminA.jar });
      }
    }

    const created = await apiCall("POST", "/api/customers", {
      jar: adminA.jar,
      body: { name: "Privacy Probe", phone: PROBE_PHONE_RAW, marketingConsent: true },
    });
    expect(created.status).toBe(201);
    probeCustomerId = created.body.customer.id;
    expect(probeCustomerId).toBeTruthy();

    const visit = await apiCall("POST", "/api/restaurant/visits", {
      jar: adminA.jar,
      body: { customerId: probeCustomerId, orderAmount: 99000, source: "WALK_IN" },
    });
    expect(visit.status).toBe(201);
  });

  test("leaderboard API returns masked phone and never the raw number", async () => {
    const res = await apiCall("GET", "/api/restaurant/leaderboard", { jar: adminA.jar });
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(PROBE_PHONE_RAW);
    expect(text).not.toContain("9999991234");
    const entry = (res.body.leaderboard ?? []).find(
      (c: { id: string }) => c.id === probeCustomerId,
    );
    expect(entry).toBeTruthy();
    expect(entry.phone).toBe("******1234");
  });

  test("restaurant visits API returns masked phone", async () => {
    const res = await apiCall("GET", "/api/restaurant/visits?pageSize=50", { jar: adminA.jar });
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(PROBE_PHONE_RAW);
    expect(text).not.toContain("9999991234");
    const row = (res.body.visits ?? []).find(
      (v: { customerId: string }) => v.customerId === probeCustomerId,
    );
    expect(row).toBeTruthy();
    expect(row.customer.phone).toBe("******1234");
  });

  test("loyalty / scoring / feedback APIs do not leak raw phone numbers", async () => {
    for (const path of [
      "/api/loyalty?pageSize=50",
      "/api/scoring?limit=50",
      "/api/feedback?pageSize=50",
    ]) {
      const res = await apiCall("GET", path, { jar: adminA.jar });
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      // No Indian raw phone (with or without +91) may appear anywhere
      expect(text).not.toContain(PROBE_PHONE_RAW);
      expect(text).not.toMatch(/\+91\d{10}/);
    }
  });

  test("AUTHORIZED customer-management flow still returns the full phone", async () => {
    const list = await apiCall("GET", `/api/customers?search=9999991234`, { jar: adminA.jar });
    expect(list.status).toBe(200);
    const row = (list.body.customers ?? []).find((c: { id: string }) => c.id === probeCustomerId);
    expect(row).toBeTruthy();
    expect(row.phone).toBe(PROBE_PHONE_RAW); // full phone behind the authorized flow

    const profile = await apiCall("GET", `/api/customers/${probeCustomerId}`, { jar: adminA.jar });
    expect(profile.status).toBe(200);
    expect(profile.body.customer.phone).toBe(PROBE_PHONE_RAW);
  });

  test("tenant A phone data never appears in tenant B responses", async () => {
    const adminB = await login(HOTEL_B_ADMIN, ADMIN_PASSWORD);
    expect(adminB.res.status).toBe(200);

    const bLeaderboard = await apiCall("GET", "/api/restaurant/leaderboard", { jar: adminB.jar });
    expect(bLeaderboard.status).toBe(200);
    const lbText = JSON.stringify(bLeaderboard.body);
    expect(lbText).not.toContain(PROBE_PHONE_RAW);
    expect(lbText).not.toContain("Privacy Probe");

    const bCustomers = await apiCall("GET", "/api/customers?search=Privacy", { jar: adminB.jar });
    expect(bCustomers.status).toBe(200);
    expect(JSON.stringify(bCustomers.body)).not.toContain("Privacy Probe");

    const bVisits = await apiCall("GET", "/api/restaurant/visits?pageSize=50", { jar: adminB.jar });
    expect(bVisits.status).toBe(200);
    expect(JSON.stringify(bVisits.body)).not.toContain(PROBE_PHONE_RAW);
  });
});

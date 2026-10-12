/**
 * Edge-case / malformed-input probe: mutation endpoints must never answer 5xx.
 * A 500 here means an unhandled exception (real defect); 4xx is the contract.
 */
import { call, summary } from "./probe-lib";

const PAYLOADS: unknown[] = [
  {},
  { garbage: true },
  { name: -1, priceMinor: -5, quantity: -3, amountMinor: -100, capacity: -1 },
  { name: "x".repeat(5000), code: "'; DROP TABLE users; --", email: "not-an-email" },
  { permissions: "not-an-array" },
  { date: "not-a-date", startTime: "99:99", partySize: -4 },
  { id: null, userId: null, hotelId: null, segmentId: null, categoryId: null, tableId: null },
];

const MUTATIONS: [string, string][] = [
  ["POST", "/api/customers"],
  ["POST", "/api/restaurant/visits"],
  ["POST", "/api/visits"],
  ["POST", "/api/campaigns"],
  ["POST", "/api/coupons"],
  ["POST", "/api/promotions"],
  ["POST", "/api/segments"],
  ["POST", "/api/menu/categories"],
  ["POST", "/api/menu/items"],
  ["POST", "/api/tables"],
  ["POST", "/api/orders"],
  ["POST", "/api/bills"],
  ["POST", "/api/sessions"],
  ["POST", "/api/reservations"],
  ["POST", "/api/inventory/ingredients"],
  ["POST", "/api/inventory/purchase-orders"],
  ["POST", "/api/inventory/counts"],
  ["POST", "/api/custom-roles"],
  ["POST", "/api/webhooks"],
  ["POST", "/api/api-keys"],
  ["POST", "/api/privacy-requests"],
  ["POST", "/api/ab-experiments"],
  ["POST", "/api/referrals"],
  ["POST", "/api/automations"],
  ["POST", "/api/templates"],
  ["POST", "/api/journeys"],
  ["POST", "/api/staff"],
  ["POST", "/api/attendance"],
  ["POST", "/api/shifts"],
  ["POST", "/api/branches"],
  ["POST", "/api/tax-rules"],
  ["POST", "/api/cash-sessions"],
  ["POST", "/api/notifications"],
  ["POST", "/api/imports/customers"],
  ["POST", "/api/export/customers"],
  ["POST", "/api/loyalty/adjust"],
  ["POST", "/api/loyalty/redeem"],
  ["POST", "/api/coupons/validate"],
  ["POST", "/api/coupons/redeem"],
  ["POST", "/api/payment-links"],
  ["POST", "/api/white-label"],
  ["POST", "/api/ai/settings"],
  ["POST", "/api/ai/recommendations"],
  ["POST", "/api/offline/sync"],
  ["POST", "/api/reports/sales"],
  ["PUT", "/api/settings"],
  ["PATCH", "/api/settings"],
  ["PATCH", "/api/profile"],
  ["POST", "/api/restaurant/segments/refresh"],
];

async function main() {
  const login = await call("POST", "/api/auth/login", { email: "admin@grandpalace.com", password: "TestAdmin123" });
  console.log("login:", login.status);

  const serverErrors: string[] = [];
  let calls = 0;
  for (const [method, path] of MUTATIONS) {
    for (const payload of PAYLOADS) {
      calls++;
      const r = await call(method, path, payload);
      if (r.status >= 500) {
        serverErrors.push(`${method} ${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      }
    }
  }
  console.log(`\nsent ${calls} malformed requests across ${MUTATIONS.length} endpoints`);
  if (serverErrors.length === 0) {
    console.log("PASS: no 5xx responses (all malformed input handled as 4xx)");
  } else {
    console.log(`FAIL: ${serverErrors.length} request(s) produced 5xx:`);
    for (const e of [...new Set(serverErrors)]) console.log("  " + e);
  }
  summary();
}

await main();

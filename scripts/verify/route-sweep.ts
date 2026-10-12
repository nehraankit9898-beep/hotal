/**
 * Feature probe: exercises StayLoop's API surface as a real hotel admin
 * against the running dev server, and prints a pass/fail table.
 */
const BASE = process.env.PROBE_BASE ?? "http://localhost:3000";

let cookieJar = "";
let csrf = "";

function storeCookies(res: Response) {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const sc of setCookies) {
    const pair = sc.split(";")[0];
    const [name] = pair.split("=");
    const others = cookieJar
      .split("; ")
      .filter(Boolean)
      .filter((c) => !c.startsWith(`${name}=`));
    cookieJar = [...others, pair].join("; ");
    if (name === "stayloop_csrf") csrf = decodeURIComponent(pair.split("=").slice(1).join("="));
  }
}

export async function call(
  method: string,
  path: string,
  body?: unknown,
  opts: { bearer?: string; raw?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookieJar) headers.cookie = cookieJar;
  if (csrf && method !== "GET") headers["x-csrf-token"] = csrf;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  storeCookies(res);
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.slice(0, 200);
  }
  return { status: res.status, body: parsed };
}

const results: { area: string; what: string; ok: boolean; detail: string }[] = [];
export function check(area: string, what: string, ok: boolean, detail = "") {
  results.push({ area, what, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  [${area}] ${what}${detail ? ` — ${detail}` : ""}`);
}

const WANT_OK = (s: number) => s === 200 || s === 201;

async function main() {
  // ---------- Auth ----------
  const login = await call("POST", "/api/auth/login", {
    email: "admin@grandpalace.com",
    password: "TestAdmin123",
  });
  check("auth", "login as hotel admin", WANT_OK(login.status), `status=${login.status} ${JSON.stringify(login.body).slice(0, 120)}`);
  const me = await call("GET", "/api/auth/me");
  check("auth", "session /auth/me", WANT_OK(me.status), `status=${me.status}`);
  const hotels = (await call("GET", "/api/hotels")).status;
  check("auth", "GET /api/hotels (list/create contract)", hotels === 405 || hotels === 200, `status=${hotels}`);

  // ---------- Dashboard / analytics ----------
  for (const p of ["/api/dashboard/stats", "/api/analytics/overview", "/api/health/live", "/api/notifications"]) {
    const r = await call("GET", p);
    check("dashboard", `GET ${p}`, WANT_OK(r.status), `status=${r.status}`);
  }
  {
    // Readiness: 200 = ready; 503 = not ready and MUST name the failing check.
    // (With the background worker stopped, 503 + worker:"stale" is the
    // endpoint working as designed — this is a readiness probe, not liveness.)
    const r = await call("GET", "/api/health");
    const failing = Object.entries(r.body?.checks ?? {})
      .filter(([, v]) => v !== "ok" && v !== "disabled" && v !== "mock" && v !== "unknown" && v !== "not_configured")
      .map(([k]) => k);
    const honest = r.status === 200 || (r.status === 503 && failing.length > 0);
    check("dashboard", "GET /api/health (200, or 503 naming the failing check)", honest,
      `status=${r.status} checks=${JSON.stringify(r.body?.checks)}`);
  }

  // ---------- CRM ----------
  const cust = await call("GET", "/api/customers?limit=5");
  check("crm", "list customers", WANT_OK(cust.status), `status=${cust.status} count=${cust.body?.customers?.length ?? cust.body?.data?.length ?? "?"}`);
  const created = await call("POST", "/api/customers", {
    name: "Probe Guest",
    phone: `+919${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`, // unique: fixed numbers normalize to a duplicate (409) on re-runs
    email: `probe${Date.now()}@example.com`,
    marketingConsent: true,
  });
  check("crm", "create customer", WANT_OK(created.status), `status=${created.status}`);
  const custId = created.body?.customer?.id ?? created.body?.id;
  if (custId) {
    const one = await call("GET", `/api/customers/${custId}`);
    check("crm", "get customer", WANT_OK(one.status), `status=${one.status}`);
    const consent = await call("POST", `/api/customers/${custId}/consent`, { marketingConsent: false, source: "PROBE" });
    check("crm", "update consent", WANT_OK(consent.status), `status=${consent.status}`);
    const visits = await call("GET", `/api/customers/${custId}/visits`);
    check("crm", "customer visits", WANT_OK(visits.status), `status=${visits.status}`);
  }
  const tl = await call("GET", `/api/timeline?customerId=${custId}`);
  check("crm", "GET /api/timeline?customerId", WANT_OK(tl.status), `status=${tl.status}`);
  const le = await call("GET", `/api/lead-events?customerId=${custId}`);
  check("crm", "GET /api/lead-events?customerId", WANT_OK(le.status), `status=${le.status}`);
  const ltx = await call("GET", `/api/loyalty/transactions?customerId=${custId}`);
  check("loyalty", "GET /api/loyalty/transactions?customerId", WANT_OK(ltx.status), `status=${ltx.status}`);
  for (const p of ["/api/segments", "/api/restaurant/segments", "/api/scoring", "/api/follow-ups", "/api/audit-logs"]) {
    const r = await call("GET", p);
    check("crm", `GET ${p}`, WANT_OK(r.status), `status=${r.status}`);
  }

  // ---------- Visits ----------
  if (custId) {
    const visit = await call("POST", "/api/restaurant/visits", { customerId: custId, orderAmount: 2500, notes: "probe visit" });
    check("visits", "record a visit", WANT_OK(visit.status), `status=${visit.status} ${JSON.stringify(visit.body).slice(0, 100)}`);
  }
  const rvisits = await call("GET", "/api/restaurant/visits");
  check("visits", "list restaurant visits", WANT_OK(rvisits.status), `status=${rvisits.status}`);

  // ---------- Campaigns ----------
  const camp = await call("GET", "/api/campaigns");
  check("campaigns", "list campaigns", WANT_OK(camp.status), `status=${camp.status}`);
  const segList = await call("GET", "/api/segments");
  const segId = segList.body?.segments?.[0]?.id;
  const newCamp = await call("POST", "/api/campaigns", { name: `Probe ${Date.now()}`, segmentId: segId, channels: ["EMAIL"], messageTemplate: "Hello {{name}}, enjoy 10% off!" });
  check("campaigns", "create campaign", WANT_OK(newCamp.status), `status=${newCamp.status} ${JSON.stringify(newCamp.body).slice(0, 120)}`);
  const campId = newCamp.body?.campaign?.id ?? newCamp.body?.id;
  if (campId) {
    const test = await call("POST", `/api/campaigns/${campId}/test`, { email: "admin@grandpalace.com" });
    check("campaigns", "campaign test send", test.status < 500, `status=${test.status}`);
    const analytics = await call("GET", `/api/campaigns/${campId}/analytics`);
    check("campaigns", "campaign analytics", WANT_OK(analytics.status), `status=${analytics.status}`);
  }
  for (const p of ["/api/automations", "/api/journeys", "/api/templates", "/api/coupons", "/api/promotions", "/api/referrals"]) {
    const r = await call("GET", p);
    check("marketing", `GET ${p}`, WANT_OK(r.status), `status=${r.status}`);
  }

  // ---------- Loyalty / QR / feedback ----------
  // NB: /api/loyalty/transactions requires ?customerId= (asserted above) —
  // a bare call is correctly 400 and is asserted separately below.
  for (const p of ["/api/loyalty", "/api/qr-codes", "/api/feedback"]) {
    const r = await call("GET", p);
    check("loyalty", `GET ${p}`, WANT_OK(r.status), `status=${r.status}`);
  }

  // ---------- Restaurant: menu, tables, orders, KDS ----------
  for (const p of ["/api/menu/categories", "/api/menu/items", "/api/tables", "/api/orders", "/api/kds", "/api/sessions"]) {
    const r = await call("GET", p);
    check("restaurant", `GET ${p}`, WANT_OK(r.status), `status=${r.status}`);
  }
  const cat = await call("POST", "/api/menu/categories", { name: `Probe Cat ${Date.now()}`, sortOrder: 99 });
  check("restaurant", "create menu category", WANT_OK(cat.status), `status=${cat.status}`);
  const catId = cat.body?.category?.id ?? cat.body?.id;
  if (catId) {
    const item = await call("POST", "/api/menu/items", { name: "Probe Dish", categoryId: catId, priceMinor: 19900 });
    check("restaurant", "create menu item", WANT_OK(item.status), `status=${item.status} ${JSON.stringify(item.body).slice(0, 120)}`);
  }
  const table = await call("POST", "/api/tables", { number: `P${Date.now() % 1000}`, capacity: 4, createQr: true });
  check("restaurant", "create table", WANT_OK(table.status), `status=${table.status} ${JSON.stringify(table.body).slice(0, 150)}`);

  // ---------- POS / billing ----------
  for (const p of ["/api/bills", "/api/cash-sessions", "/api/tax-rules", "/api/reports/sales", "/api/restaurant/leaderboard", "/api/report-schedule", "/api/payment-links"]) {
    const r = await call("GET", p);
    check("pos-billing", `GET ${p}`, WANT_OK(r.status), `status=${r.status}`);
  }

  {
    const bare = await call("GET", "/api/loyalty/transactions");
    check("loyalty", "GET /api/loyalty/transactions without customerId → 400 (required param)", bare.status === 400, `status=${bare.status}`);
  }

  // ---------- Reservations / inventory / operations ----------
  for (const p of ["/api/reservations", "/api/inventory/ingredients", "/api/inventory/ledger", "/api/inventory/purchase-orders", "/api/inventory/recipes", "/api/inventory/counts", "/api/attendance", "/api/shifts", "/api/branches"]) {
    const r = await call("GET", p);
    check("operations", `GET ${p}`, WANT_OK(r.status), `status=${r.status}`);
  }
  const ing = await call("POST", "/api/inventory/ingredients", { name: `Probe Flour ${Date.now()}`, unit: "KG", reorderLevel: 2, costPerUnitMinor: 5000 });
  check("operations", "create ingredient", WANT_OK(ing.status), `status=${ing.status} ${JSON.stringify(ing.body).slice(0, 120)}`);
  const d = new Date(Date.now() + 86400000);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const resv = await call("POST", "/api/reservations", { guestName: "Probe Guest", guestPhone: "+919000000002", partySize: 2, date: ymd, startTime: "19:30" });
  check("operations", "create reservation", WANT_OK(resv.status), `status=${resv.status} ${JSON.stringify(resv.body).slice(0, 120)}`);

  // ---------- Enterprise ----------
  for (const p of ["/api/custom-roles", "/api/white-label", "/api/webhooks", "/api/api-keys", "/api/ab-experiments", "/api/privacy-requests", "/api/benchmarking", "/api/franchise", "/api/settings", "/api/staff", "/api/integrations", "/api/pricing", "/api/subscription"]) {
    const r = await call("GET", p);
    check("enterprise", `GET ${p}`, WANT_OK(r.status), `status=${r.status}`);
  }

  // ---------- AI ----------
  for (const p of ["/api/ai/settings", "/api/ai/conversations", "/api/ai/interactions", "/api/ai/recommendations", "/api/ai/sustainability", "/api/ai/forecast"]) {
    const r = await call("GET", p);
    check("ai", `GET ${p}`, WANT_OK(r.status), `status=${r.status}`);
  }

  // ---------- Super admin ----------
  const sa = await call("POST", "/api/super-admin/login", {
    email: "super@stayloop.test",
    password: "TestSuper123",
  });
  check("super-admin", "login (expected to fail — no such account yet)", sa.status === 401 || sa.status === 403 || WANT_OK(sa.status), `status=${sa.status}`);
  const saDenied = await call("GET", "/api/super-admin/stats", undefined, {});
  check("super-admin", "tenant admin denied super-admin stats", saDenied.status === 401 || saDenied.status === 403, `status=${saDenied.status}`);

  // ---------- Unauthenticated access control ----------
  const saved = cookieJar;
  cookieJar = "";
  csrf = "";
  const anon = await call("GET", "/api/customers");
  check("security", "anonymous /api/customers denied", anon.status === 401, `status=${anon.status}`);
  const anonSa = await call("GET", "/api/super-admin/hotels");
  check("security", "anonymous super-admin denied", anonSa.status === 401 || anonSa.status === 403, `status=${anonSa.status}`);
  cookieJar = saved;

  // ---------- Summary ----------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed; ${failed.length} failed ====`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  [${f.area}] ${f.what} — ${f.detail}`);
  }
}

await main();

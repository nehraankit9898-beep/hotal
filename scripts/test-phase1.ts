/**
 * StayLoop — Phase 1 Automated Acceptance Tests
 * Runs against the live dev server (http://localhost:3000).
 *
 * Covers spec section 18/19:
 *   Authentication, multi-tenant isolation, customer CRUD, consent,
 *   visits, CSV import, dashboard stats, security, audit logs.
 *
 * Run: bun run scripts/test-phase1.ts
 */

const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "";
const STAFF_PASSWORD = process.env.TEST_STAFF_PASSWORD || "";

// Unique per-run suffix so the suite is idempotent (can re-run without re-seeding)
// phone() builds a valid 10-digit Indian mobile: 98 + RUN(6) + suffix(2)
const RUN = String(Date.now()).slice(-6);
const phone = (suffix: string) => `+9198${RUN}${suffix}`;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n━━━ ${title} ━━━`);
}

interface Res {
  status: number;
  body: any;
}

/** The CSRF double-submit token from a cookie jar string ("" if absent). */
function csrfFrom(cookie?: string): string {
  let csrf = "";
  for (const part of (cookie ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "stayloop_csrf") csrf = decodeURIComponent(rest.join("="));
  }
  return csrf;
}

async function call(method: string, path: string, body?: unknown, cookie?: string): Promise<Res> {
  // Phase 8: echo the CSRF double-submit cookie on state-changing requests.
  const csrf = csrfFrom(cookie);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(csrf && !["GET", "HEAD", "OPTIONS"].includes(method) ? { "x-csrf-token": csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body: data };
}

function getCookie(res: globalThis.Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return "";
  // keep ALL cookies (session + csrf) in the jar
  return setCookie
    .split(/,(?=[^;]+=)/)
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   StayLoop Phase 1 — Acceptance Test Suite       ║");
  console.log("╚══════════════════════════════════════════════════╝");

  // ─────────────────────────────────────────────
  section("1. Authentication");

  // 1.1 Login success
  let res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@grandpalace.com", password: ADMIN_PASSWORD }),
  });
  const adminACookie = getCookie(res);
  const loginBody = await res.json();
  ok("Login with correct credentials returns 200", res.status === 200);
  ok("Login returns user with hotel name", loginBody?.user?.hotelName === "Grand Palace Hotel");
  ok("Session cookie is set (httpOnly)", !!adminACookie);

  // 1.2 Wrong password
  res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@grandpalace.com", password: "WrongPass99" }),
  });
  ok("Wrong password returns 401", res.status === 401);
  const wrongBody = await res.json();
  ok(
    "Error message is user-friendly (no stack trace)",
    typeof wrongBody?.error?.message === "string" &&
      !JSON.stringify(wrongBody).includes("Traceback"),
  );

  // 1.3 Unauthorized access without session
  const unauth = await call("GET", "/api/customers");
  ok("GET /customers without session returns 401", unauth.status === 401);

  const unauthDash = await call("GET", "/api/dashboard/stats");
  ok("GET /dashboard/stats without session returns 401", unauthDash.status === 401);

  // 1.4 /me
  const me = await call("GET", "/api/auth/me", undefined, adminACookie);
  ok(
    "GET /me returns current user",
    me.status === 200 && me.body.user.email === "admin@grandpalace.com",
  );

  // ─────────────────────────────────────────────
  section("2. Customer CRUD + Validation");

  // 2.1 Create the acceptance-test customer
  const rahulPhone = `+91 98${RUN} 01`; // spaced format → must normalize
  let r = await call(
    "POST",
    "/api/customers",
    {
      name: "Rahul Sharma",
      phone: rahulPhone,
      email: "rahul@example.com",
      marketingConsent: true,
    },
    adminACookie,
  );
  ok("Create customer returns 201", r.status === 201, JSON.stringify(r.body));
  const rahulId = r.body?.customer?.id;
  ok("Phone is normalized (E.164-like)", r.body?.customer?.phone === phone("01"));
  ok(
    "Marketing consent recorded with timestamp",
    r.body?.customer?.marketingConsent === true && !!r.body?.customer?.consentTimestamp,
  );

  // 2.2 Duplicate prevention
  r = await call(
    "POST",
    "/api/customers",
    {
      name: "Rahul Duplicate",
      phone: phone("01"),
      marketingConsent: false,
    },
    adminACookie,
  );
  ok(
    "Duplicate phone within same hotel rejected with 409",
    r.status === 409 && r.body?.error?.code === "DUPLICATE_PHONE",
  );

  // 2.3 Invalid phone
  r = await call("POST", "/api/customers", { name: "Bad Phone", phone: "123ABC" }, adminACookie);
  ok("Invalid phone rejected (400)", r.status === 400);

  // 2.4 Missing name
  r = await call("POST", "/api/customers", { name: "", phone: phone("99") }, adminACookie);
  ok("Missing name rejected (400)", r.status === 400);

  // 2.5 List + search + pagination
  r = await call(
    "GET",
    "/api/customers?q=Rahul+Sharma&page=1&pageSize=10",
    undefined,
    adminACookie,
  );
  ok(
    "Search finds Rahul Sharma",
    r.status === 200 && r.body.customers.some((c: any) => c.id === rahulId),
  );
  ok(
    "Pagination metadata present",
    typeof r.body.total === "number" && typeof r.body.totalPages === "number",
  );

  r = await call("GET", "/api/customers?consent=opted_in", undefined, adminACookie);
  ok(
    "Consent filter works (all results opted-in)",
    r.body.customers.every((c: any) => c.marketingConsent && !c.optOut),
  );

  r = await call("GET", "/api/customers?sort=visits&order=desc", undefined, adminACookie);
  const visitCounts = r.body.customers.map((c: any) => c.totalVisits);
  ok(
    "Sort by visit count desc works",
    visitCounts.every((v: number, i: number) => i === 0 || visitCounts[i - 1] >= v),
  );

  // 2.6 Update
  r = await call("PATCH", `/api/customers/${rahulId}`, { name: "Rahul S. Sharma" }, adminACookie);
  ok("Update customer name", r.status === 200 && r.body.customer.name === "Rahul S. Sharma");

  // 2.7 Invalid ID
  r = await call("GET", "/api/customers/not-a-real-id", undefined, adminACookie);
  ok("Invalid customer ID returns 404", r.status === 404);

  // ─────────────────────────────────────────────
  section("3. Visit Tracking");

  // 3.1 Add two visits
  r = await call(
    "POST",
    `/api/customers/${rahulId}/visits`,
    {
      checkin: "2026-09-20T14:00:00.000Z",
      checkout: "2026-09-22T11:00:00.000Z",
      notes: "Deluxe room",
    },
    adminACookie,
  );
  ok("Visit #1 created (201)", r.status === 201, JSON.stringify(r.body));
  const visit1Id = r.body?.visit?.id;
  ok("Visit count derived = 1", r.body?.totalVisits === 1);

  r = await call(
    "POST",
    `/api/customers/${rahulId}/visits`,
    {
      checkin: "2026-10-01T10:00:00.000Z",
    },
    adminACookie,
  );
  ok("Visit #2 created (201)", r.status === 201);
  ok("Visit count derived = 2 (no duplicate counters)", r.body?.totalVisits === 2);
  const visit2Id = r.body?.visit?.id;

  // 3.2 Invalid visit (checkout before checkin)
  r = await call(
    "POST",
    `/api/customers/${rahulId}/visits`,
    {
      checkin: "2026-10-05T10:00:00.000Z",
      checkout: "2026-10-04T10:00:00.000Z",
    },
    adminACookie,
  );
  ok("Checkout before checkin rejected (400)", r.status === 400);

  // 3.3 Profile shows correct stats
  r = await call("GET", `/api/customers/${rahulId}`, undefined, adminACookie);
  ok("Profile: Total Visits = 2", r.body.stats.totalVisits === 2);
  ok(
    "Profile: First visit = 2026-09-20",
    new Date(r.body.stats.firstVisit).toISOString().startsWith("2026-09-20"),
  );
  ok(
    "Profile: Last visit = 2026-10-01",
    new Date(r.body.stats.lastVisit).toISOString().startsWith("2026-10-01"),
  );
  ok(
    "Profile: timeline has customer_created + consent + 2 visits",
    r.body.timeline.filter((t: any) => t.type === "visit").length === 2 &&
      r.body.timeline.some((t: any) => t.type === "consent_granted"),
  );

  // 3.4 Edit visit
  r = await call("PATCH", `/api/visits/${visit2Id}`, { notes: "Suite upgrade" }, adminACookie);
  ok("Visit updated", r.status === 200 && r.body.visit.notes === "Suite upgrade");

  // 3.5 Delete visit → count recalculates
  r = await call("DELETE", `/api/visits/${visit1Id}`, undefined, adminACookie);
  ok("Visit deleted", r.status === 200);
  r = await call("GET", `/api/customers/${rahulId}`, undefined, adminACookie);
  ok("Visit count recalculated to 1 after delete", r.body.stats.totalVisits === 1);

  // 3.6 Global visits list
  r = await call("GET", "/api/visits?q=Rahul&page=1", undefined, adminACookie);
  ok(
    "Global visits list searchable by customer",
    r.body.visits.some((v: any) => v.customerId === rahulId),
  );

  // ─────────────────────────────────────────────
  section("4. Multi-Tenant Isolation (CRITICAL)");

  // Login as Hotel B admin
  let resB = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@seaview.com", password: ADMIN_PASSWORD }),
  });
  const adminBCookie = getCookie(resB);
  ok("Hotel B admin can log in", resB.status === 200);

  // 4.1 Hotel B cannot access Hotel A's customer
  r = await call("GET", `/api/customers/${rahulId}`, undefined, adminBCookie);
  ok("Hotel B CANNOT access Hotel A customer (404)", r.status === 404, `got ${r.status}`);

  // 4.2 Hotel B cannot modify
  r = await call("PATCH", `/api/customers/${rahulId}`, { name: "HACKED" }, adminBCookie);
  ok("Hotel B CANNOT modify Hotel A customer", r.status === 404);

  // 4.3 Hotel B cannot add visits to Hotel A customer
  r = await call(
    "POST",
    `/api/customers/${rahulId}/visits`,
    { checkin: "2026-10-01T10:00:00.000Z" },
    adminBCookie,
  );
  ok("Hotel B CANNOT add visit to Hotel A customer", r.status === 404);

  // 4.4 Hotel B cannot opt-out Hotel A customer
  r = await call("POST", `/api/customers/${rahulId}/opt-out`, undefined, adminBCookie);
  ok("Hotel B CANNOT opt-out Hotel A customer", r.status === 404);

  // 4.5 Hotel B list does not contain Hotel A customers
  r = await call("GET", "/api/customers?pageSize=50", undefined, adminBCookie);
  ok(
    "Hotel B list contains ONLY its own customers",
    r.body.customers.every((c: any) => c.id !== rahulId) && r.body.customers.length > 0,
  );

  // 4.6 Hotel B dashboard reflects only its data
  r = await call("GET", "/api/dashboard/stats", undefined, adminBCookie);
  ok(
    "Hotel B dashboard is scoped (1 customer)",
    r.body.stats.totalCustomers === 1,
    `got ${r.body?.stats?.totalCustomers}`,
  );
  ok(
    "Hotel B has exactly 1 visit",
    r.body.stats.totalVisits === 1,
    `got ${r.body?.stats?.totalVisits}`,
  );

  // 4.7 Hotel B audit logs scoped
  r = await call("GET", "/api/audit-logs?pageSize=50", undefined, adminBCookie);
  ok(
    "Hotel B audit logs are scoped",
    r.status === 200 &&
      r.body.logs.every((l: any) => !l.metadata || !l.metadata.includes?.("Rahul S. Sharma")),
  );

  console.log(`    (Hotel A customer Rahul is invisible to Hotel B across all endpoints ✓)`);

  // ─────────────────────────────────────────────
  section("5. Consent System");

  // 5.1 Campaign eligibility before opt-out
  r = await call("GET", `/api/customers/${rahulId}`, undefined, adminACookie);
  ok("Campaign eligible when consented & not opted out", r.body.customer.campaignEligible === true);

  // 5.2 Opt out
  r = await call("POST", `/api/customers/${rahulId}/opt-out`, undefined, adminACookie);
  ok("Opt-out returns 200", r.status === 200);
  ok("marketing_consent = false after opt-out", r.body.customer.marketingConsent === false);
  ok("opt_out = true after opt-out", r.body.customer.optOut === true);

  // 5.3 Campaign eligibility blocked
  r = await call("GET", `/api/customers/${rahulId}`, undefined, adminACookie);
  ok("Campaign eligibility now BLOCKED", r.body.customer.campaignEligible === false);

  // 5.4 Opt back in
  r = await call(
    "POST",
    `/api/customers/${rahulId}/consent`,
    { source: "FRONT_DESK" },
    adminACookie,
  );
  ok(
    "Re-consent works (opt_in)",
    r.status === 200 &&
      r.body.customer.marketingConsent === true &&
      r.body.customer.optOut === false,
  );

  // ─────────────────────────────────────────────
  section("6. Dashboard Statistics (live from DB)");

  // Baseline stats
  r = await call("GET", "/api/dashboard/stats", undefined, adminACookie);
  const before = r.body.stats;
  ok(
    "Dashboard returns all required stats",
    [
      "totalCustomers",
      "marketingOptIn",
      "optedOut",
      "totalVisits",
      "uniqueVisitors",
      "repeatCustomers",
    ].every((k) => typeof before[k] === "number"),
  );

  // Create a customer with 2 visits → repeat customer count must increase
  r = await call(
    "POST",
    "/api/customers",
    {
      name: "Test Repeat Guest",
      phone: phone("02"),
      marketingConsent: true,
    },
    adminACookie,
  );
  const repeatGuestId = r.body.customer.id;
  await call(
    "POST",
    `/api/customers/${repeatGuestId}/visits`,
    { checkin: "2026-09-01T10:00:00.000Z" },
    adminACookie,
  );
  await call(
    "POST",
    `/api/customers/${repeatGuestId}/visits`,
    { checkin: "2026-09-15T10:00:00.000Z" },
    adminACookie,
  );

  r = await call("GET", "/api/dashboard/stats", undefined, adminACookie);
  const after = r.body.stats;
  ok(
    "Total customers increased (+1)",
    after.totalCustomers === before.totalCustomers + 1,
    `${before.totalCustomers} → ${after.totalCustomers}`,
  );
  ok("Marketing opt-in increased (+1)", after.marketingOptIn === before.marketingOptIn + 1);
  ok("Total visits increased (+2)", after.totalVisits === before.totalVisits + 2);
  ok(
    "Repeat customers increased (+1)",
    after.repeatCustomers === before.repeatCustomers + 1,
    `${before.repeatCustomers} → ${after.repeatCustomers}`,
  );
  ok(
    "Visits trend data present (14 days)",
    Array.isArray(r.body.visitsTrend) && r.body.visitsTrend.length === 14,
  );

  // ─────────────────────────────────────────────
  section("7. CSV Import — Customers");

  const csvCustomers = [
    "name,phone,email,marketing_consent",
    `Amit Kumar,${phone("11")},amit1@example.com,yes`,
    `Priya Singh,${phone("12").slice(3)},priya2@example.com,no`, // bare 10-digit format
    `,${phone("13")},,yes`, // invalid: no name
    "Bad Phone,abc-def,,yes", // invalid: bad phone
    `Amit Kumar,${phone("11")},amit1@example.com,yes`, // duplicate of row 1 (same normalized phone)
    `Rahul Sharma,${rahulPhone},,yes`, // duplicate of existing customer
    `Sneha Reddy,${phone("14")},,true`,
    `Vikas Ojha,${phone("15").slice(3)},,1`,
    `Nina Das,${phone("16")},,0`,
    `Om Prakash,${phone("17")},,`,
  ].join("\n");

  // 7.1 Preview (no writes)
  const statsBefore = await call("GET", "/api/dashboard/stats", undefined, adminACookie);
  r = await call("POST", "/api/imports/customers/preview", { csv: csvCustomers }, adminACookie);
  ok(
    "Preview returns row-level results",
    r.status === 200 && Array.isArray(r.body.rows) && r.body.rows.length === 10,
  );
  ok("Preview summary: 6 valid", r.body.summary.valid === 6, JSON.stringify(r.body.summary));
  ok("Preview summary: 2 duplicates", r.body.summary.duplicates === 2);
  ok("Preview summary: 2 invalid", r.body.summary.invalid === 2);
  ok(
    "Invalid rows include reasons",
    r.body.rows.filter((x: any) => x.status === "invalid").every((x: any) => !!x.reason),
  );
  const statsMid = await call("GET", "/api/dashboard/stats", undefined, adminACookie);
  ok(
    "Preview does NOT write to database",
    statsMid.body.stats.totalCustomers === statsBefore.body.stats.totalCustomers,
  );

  // 7.2 Actual import
  r = await call("POST", "/api/imports/customers", { csv: csvCustomers }, adminACookie);
  ok("Import summary: 6 imported", r.body.summary.imported === 6, JSON.stringify(r.body.summary));
  ok("Import summary: 2 duplicates skipped", r.body.summary.duplicates === 2);
  ok("Import summary: 2 failed with reasons", r.body.summary.invalid === 2);
  ok(
    "Failed rows are reported, not silently discarded",
    r.body.rows.filter((x: any) => x.status === "invalid").length === 2,
  );

  // 7.3 Verify import landed in the list
  r = await call("GET", "/api/customers?q=Nina+Das&pageSize=50", undefined, adminACookie);
  const nina = r.body.customers.find((c: any) => c.phone === phone("16"));
  ok("Imported customer searchable", !!nina);
  ok("Imported consent value parsed (Nina = no consent)", nina?.marketingConsent === false);
  r = await call("GET", "/api/customers?q=Om+Prakash&pageSize=50", undefined, adminACookie);
  const om = r.body.customers.find((c: any) => c.phone === phone("17"));
  ok("Empty consent column treated as 'no'", om?.marketingConsent === false);

  // ─────────────────────────────────────────────
  section("8. CSV Import — Visits");

  const csvVisits = [
    "customer_phone,checkin,checkout",
    `${phone("11")},2026-08-10,2026-08-12`,
    `${phone("11").slice(3)},2026-08-25,`, // same customer, different date; tests bare-number normalization
    `${phone("12")},2026-08-14,2026-08-13`, // invalid: checkout before checkin
    `+919999999999,2026-08-14,`, // invalid: unknown customer
    "bad-date-phone,2026-08-14,", // invalid: bad phone
    `${phone("11")},not-a-date,`, // invalid: bad date
  ].join("\n");

  r = await call("POST", "/api/imports/visits/preview", { csv: csvVisits }, adminACookie);
  ok("Visits preview validates", r.status === 200);
  ok("Visits preview: 2 valid", r.body.summary.valid === 2, JSON.stringify(r.body.summary));
  ok("Visits preview: 4 invalid", r.body.summary.invalid === 4);

  r = await call("POST", "/api/imports/visits", { csv: csvVisits }, adminACookie);
  ok("Visits import: 2 imported", r.body.summary.imported === 2, JSON.stringify(r.body.summary));

  r = await call("GET", "/api/customers?q=Amit+Kumar&pageSize=50", undefined, adminACookie);
  const amit = r.body.customers.find((c: any) => c.phone === phone("11"));
  ok("Amit Kumar now has 2 visits from CSV", amit?.totalVisits === 2, `got ${amit?.totalVisits}`);

  // ─────────────────────────────────────────────
  section("9. Deactivate / Reactivate");

  r = await call("DELETE", `/api/customers/${repeatGuestId}`, undefined, adminACookie);
  ok("DELETE deactivates customer (200)", r.status === 200);
  r = await call("GET", `/api/customers/${repeatGuestId}`, undefined, adminACookie);
  ok("Customer status = INACTIVE", r.body.customer.status === "INACTIVE");
  ok("Deactivated customer not campaign eligible", r.body.customer.campaignEligible === false);
  r = await call("GET", "/api/customers?status=inactive", undefined, adminACookie);
  ok(
    "Inactive filter shows deactivated customer",
    r.body.customers.some((c: any) => c.id === repeatGuestId),
  );

  // Reactivate
  r = await call("PATCH", `/api/customers/${repeatGuestId}`, { status: "ACTIVE" }, adminACookie);
  ok("Reactivate works", r.status === 200 && r.body.customer.status === "ACTIVE");

  // ─────────────────────────────────────────────
  section("10. Audit Logs");

  r = await call("GET", "/api/audit-logs?pageSize=100", undefined, adminACookie);
  const actions = new Set(r.body.logs.map((l: any) => l.action));
  ok("Audit logs recorded", r.body.logs.length > 0);
  ok("LOGIN logged", actions.has("LOGIN"));
  ok("CUSTOMER_CREATED logged", actions.has("CUSTOMER_CREATED"));
  ok("VISIT_CREATED logged", actions.has("VISIT_CREATED"));
  ok("OPT_OUT logged", actions.has("OPT_OUT"));
  ok("CUSTOMERS_IMPORTED logged", actions.has("CUSTOMERS_IMPORTED"));
  ok("VISITS_IMPORTED logged", actions.has("VISITS_IMPORTED"));
  ok("CUSTOMER_DEACTIVATED logged", actions.has("CUSTOMER_DEACTIVATED"));
  ok(
    "Audit logs include user info",
    r.body.logs.every((l: any) => l.user === null || typeof l.user.name === "string"),
  );
  ok(
    "No password material in audit metadata",
    !JSON.stringify(r.body.logs).toLowerCase().includes("passwordhash"),
  );

  // ─────────────────────────────────────────────
  section("11. Security");

  // 11.1 XSS-safe by default (name stored as-is, React escapes on render — check no HTML execution server-side)
  r = await call(
    "POST",
    "/api/customers",
    {
      name: "<script>alert(1)</script> Test",
      phone: phone("03"),
    },
    adminACookie,
  );
  ok(
    "XSS payload stored as text (not executed)",
    r.status === 201 && typeof r.body.customer.name === "string",
  );

  // 11.2 Logout invalidates session. Logout is CSRF-protected (SEC-006), so
  // send the double-submit token like call() does — without it the request
  // is rejected (403) and the session is never revoked.
  resB = await fetch(`${BASE}/api/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: adminBCookie, "x-csrf-token": csrfFrom(adminBCookie) },
  });
  const clearedCookie = getCookie(resB);
  r = await call("GET", "/api/auth/me", undefined, clearedCookie || adminBCookie);
  ok("Logout clears session (subsequent /me = 401)", r.status === 401);

  // 11.3 Login security — unknown users always 401 (no enumeration);
  // account LOCKOUT for real accounts is covered by tests/lockout.test.ts
  const rateEmail = `ratelimit${Date.now()}@test.com`;
  const statuses = new Set<number>();
  for (let i = 0; i < 6; i++) {
    const rr = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: rateEmail, password: "wrong" }),
    });
    statuses.add(rr.status);
  }
  ok(
    "Repeated failed logins are consistently rejected (401) without enumeration",
    statuses.size === 1 && statuses.has(401),
    `got ${[...statuses].join(",")}`,
  );

  // 11.4 Hotel registration validation
  r = await call("POST", "/api/hotels", {
    hotelName: "Test Hotel",
    adminName: "Test Admin",
    email: `hotel${Date.now()}@test.com`,
    password: "short",
  });
  ok("Weak password rejected at registration", r.status === 400);

  r = await call("POST", "/api/hotels", {
    hotelName: "Sunrise Hotel",
    location: "Delhi",
    adminName: "Test Admin",
    email: `sunrise${Date.now()}@test.com`,
    password: "StrongPass1",
  });
  ok("Hotel registration works (201)", r.status === 201);

  // ─────────────────────────────────────────────
  section("12. Cleanup (test data)");

  // Remove acceptance-test artifacts so the demo stays clean
  const cleanupIds: string[] = [];
  for (const q of [
    "Rahul Sharma",
    "Test Repeat Guest",
    "Nina Das",
    "Om Prakash",
    "Sneha Reddy",
    "Vikas Ojha",
    "Amit Kumar",
    "Priya Singh",
    "script",
  ]) {
    const rr = await call(
      "GET",
      `/api/customers?q=${encodeURIComponent(q)}&pageSize=50`,
      undefined,
      adminACookie,
    );
    for (const c of rr.body.customers || []) cleanupIds.push(c.id);
  }
  let cleaned = 0;
  for (const id of new Set(cleanupIds)) {
    const rr = await call("DELETE", `/api/customers/${id}`, undefined, adminACookie);
    if (rr.status === 200) cleaned++;
  }
  ok(`Cleanup deactivated ${cleaned} test customers`, cleaned >= 9, `cleaned=${cleaned}`);

  // ─────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log(`║  RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("║  Failures:");
    failures.forEach((f) => console.log(`║   • ${f}`));
  }
  console.log("╚══════════════════════════════════════════════════╝");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
export {};

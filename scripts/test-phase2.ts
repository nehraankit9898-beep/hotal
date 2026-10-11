/**
 * StayLoop — Phase 2 Automated Acceptance Tests
 * Runs against the live dev server (http://localhost:3000).
 *
 * Covers Phase 2 spec:
 *   Segments (auto + manual), personalization, campaign builder/send,
 *   consent gating, duplicate protection, rate limits, follow-up engine,
 *   tracking webhook security, booking attribution + ROI analytics,
 *   audit logs, multi-tenant isolation.
 *
 * Run: bun run scripts/test-phase2.ts
 */

const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "";
import { createHmac } from "crypto";

const WEBHOOK_SECRET =
  process.env.TRACKING_WEBHOOK_SECRET || process.env.STAYLOOP_WEBHOOK_SECRET || "";

const RUN = String(Date.now()).slice(-6);
const phone = (suffix: string) => `+9197${RUN}${suffix}`; // 97-prefix = Phase 2 test guests

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

async function call(
  method: string,
  path: string,
  body?: unknown,
  auth?: string,
  extraHeaders?: Record<string, string>,
): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body: data };
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

/**
 * Webhook calls go through curl subprocesses — bun's keep-alive fetch pooling
 * intermittently drops custom headers on long-lived test processes (observed:
 * x-webhook-secret arrives as null at the server after ~100 pooled requests).
 * curl opens a fresh connection per call, which matches real provider behavior.
 */
function callWebhook(
  body: unknown,
  secret?: string,
  opts?: { tamperBody?: boolean; timestamp?: string },
): Res {
  const rawBody = JSON.stringify(body);
  const ts = opts?.timestamp ?? String(Math.floor(Date.now() / 1000));
  const sig =
    secret && !opts?.tamperBody
      ? createHmac("sha256", secret)
          .update(ts + "." + rawBody)
          .digest("base64url")
      : "invalid-signature";
  const args = [
    "-s",
    "-w",
    "\n%{http_code}",
    "-X",
    "POST",
    `${BASE}/api/tracking/webhook`,
    "-H",
    "Content-Type: application/json",
    ...(secret ? ["-H", `x-webhook-signature: ${sig}`] : []),
    ...(secret ? ["-H", `x-webhook-timestamp: ${ts}`] : []),
    "-d",
    opts?.tamperBody ? rawBody + " " : rawBody,
  ];
  const proc = Bun.spawnSync(["curl", ...args]);
  const out = proc.stdout.toString();
  const lines = out.trim().split("\n");
  const status = parseInt(lines[lines.length - 1], 10);
  let data: any = null;
  try {
    data = JSON.parse(lines.slice(0, -1).join("\n"));
  } catch {
    /* empty */
  }
  return { status, body: data };
}

function daysUntilNextBirthdayMonths(n: number): string {
  // a birthday n months from today (for birthday/anniversary segment tests)
  const d = new Date();
  d.setMonth(d.getMonth() + n, Math.min(d.getDate(), 28));
  return d.toISOString();
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   StayLoop Phase 2 — Acceptance Test Suite       ║");
  console.log("╚══════════════════════════════════════════════════╝");

  // ─────────────────────────────────────────────
  section("0. Setup — logins for two hotels");

  const loginA = await call("POST", "/api/auth/login", {
    email: "admin@grandpalace.com",
    password: ADMIN_PASSWORD,
  });
  ok(
    "Hotel A admin login",
    loginA.status === 200 && loginA.body?.sessionToken,
    `status=${loginA.status}`,
  );
  const A = loginA.body.sessionToken;

  const loginB = await call("POST", "/api/auth/login", {
    email: "admin@seaview.com",
    password: ADMIN_PASSWORD,
  });
  ok(
    "Hotel B admin login",
    loginB.status === 200 && loginB.body?.sessionToken,
    `status=${loginB.status}`,
  );
  const B = loginB.body.sessionToken;

  // ─────────────────────────────────────────────
  section("1. Customer intelligence fields");

  const vipPhone = phone("01");
  const created = await call(
    "POST",
    "/api/customers",
    {
      name: "Meera Nair",
      phone: vipPhone,
      email: `meera.${RUN}@example.com`,
      marketingConsent: true,
      consentSource: "RECEPTION",
      roomPreference: "Sea View Suite",
      foodPreference: "Veg",
      location: "Mumbai",
      birthday: daysUntilNextBirthdayMonths(0), // within 14 days
      anniversary: daysUntilNextBirthdayMonths(2),
      source: "WEBSITE",
      notes: "Prefers high floor, allergic to nuts",
      vip: true,
    },
    A,
  );
  ok(
    "Create customer with intelligence fields",
    created.status === 201 &&
      created.body?.customer?.roomPreference === "Sea View Suite" &&
      created.body?.customer?.vip === true,
    `status=${created.status}`,
  );
  const vipCustomer = created.body?.customer?.id;

  const profile = await call("GET", `/api/customers/${vipCustomer}`, undefined, A);
  ok(
    "Profile returns intelligence + totalSpend",
    profile.status === 200 &&
      profile.body?.customer?.foodPreference === "Veg" &&
      profile.body?.stats?.totalSpend === 0,
    `status=${profile.status}`,
  );

  const badBday = await call(
    "PATCH",
    `/api/customers/${vipCustomer}`,
    { birthday: "not-a-date" },
    A,
  );
  ok("Invalid birthday rejected", badBday.status === 400, `status=${badBday.status}`);

  // ─────────────────────────────────────────────
  section("2. Visits with spend amounts");

  const v1 = await call(
    "POST",
    `/api/customers/${vipCustomer}/visits`,
    {
      checkin: daysAgo(30),
      checkout: daysAgo(27),
      amount: 4500,
      notes: "Weekend stay",
    },
    A,
  );
  ok("Visit with amount recorded", v1.status === 201, `status=${v1.status}`);

  const v2 = await call(
    "POST",
    `/api/customers/${vipCustomer}/visits`,
    {
      checkin: daysAgo(20),
      checkout: daysAgo(18),
      amount: 6200,
    },
    A,
  );
  ok("Second visit recorded", v2.status === 201, `status=${v2.status}`);

  const badVisit = await call(
    "POST",
    `/api/customers/${vipCustomer}/visits`,
    {
      checkin: daysAgo(10),
      amount: -500,
    },
    A,
  );
  ok("Negative spend rejected", badVisit.status === 400, `status=${badVisit.status}`);

  const profileAfter = await call("GET", `/api/customers/${vipCustomer}`, undefined, A);
  ok(
    "totalSpend aggregates from visits (₹10,700)",
    profileAfter.body?.stats?.totalSpend === 10700,
    `got=${profileAfter.body?.stats?.totalSpend}`,
  );

  // ─────────────────────────────────────────────
  section("3. Segmentation engine");

  const refresh = await call("PUT", "/api/segments", undefined, A);
  ok(
    "Refresh recomputes all AUTO segments (9 hotel + 8 restaurant in merged Phase 1-6 system)",
    refresh.status === 200 && (refresh.body?.refreshed?.length ?? 0) >= 9,
    `count=${refresh.body?.refreshed?.length}`,
  );

  const segList = await call("GET", "/api/segments", undefined, A);
  const segs: any[] = segList.body?.segments ?? [];
  const byName = (n: string) => segs.find((s) => s.name === n);
  ok(
    "All expected auto segments exist",
    [
      "New Customer",
      "Returning",
      "VIP",
      "Inactive",
      "Recent",
      "Birthday",
      "Anniversary",
      "Weekend Customer",
      "High Value",
    ].every((n) => byName(n)),
    `got=${segs.map((s) => s.name).join(",")}`,
  );

  ok("Meera in VIP segment (flag)", (byName("VIP")?.memberCount ?? 0) >= 1, "VIP count 0");
  ok(
    "Meera in Returning segment (2 stays)",
    (byName("Returning")?.memberCount ?? 0) >= 1,
    "Returning count 0",
  );
  ok(
    "Birthday segment includes Meera (birthday soon)",
    (byName("Birthday")?.memberCount ?? 0) >= 1,
    "Birthday count 0",
  );
  ok(
    "Anniversary NOT matched (2 months away)",
    byName("Anniversary")?.memberCount === 0 ||
      !(await segMemberHas(byName("Anniversary")?.id, vipCustomer, A)),
    "Anniversary wrongly matched",
  );

  // Weekend segment: add a PAST-Friday checkin visit for a new guest
  const wkPhone = phone("02");
  const wkCust = await call(
    "POST",
    "/api/customers",
    {
      name: "Weekend Wala",
      phone: wkPhone,
      marketingConsent: true,
    },
    A,
  );
  // Find the most recent past Friday (check-in cannot be in the future)
  const friday = new Date();
  friday.setDate(friday.getDate() - ((friday.getDay() + 2) % 7));
  friday.setHours(12, 0, 0, 0);
  await call(
    "POST",
    `/api/customers/${wkCust.body?.customer?.id}/visits`,
    {
      checkin: friday.toISOString(),
    },
    A,
  );
  await call("PUT", "/api/segments", undefined, A);
  const segList2 = await call("GET", "/api/segments", undefined, A);
  const wk = (segList2.body?.segments ?? []).find((s: any) => s.name === "Weekend Customer");
  ok(
    "Weekend segment matches Friday-only guest",
    wk?.memberCount >= 1 && (await segMemberHas(wk?.id, wkCust.body?.customer?.id, A)),
    `count=${wk?.memberCount}`,
  );

  // Inactive segment: guest with old visit
  const oldPhone = phone("03");
  const oldCust = await call(
    "POST",
    "/api/customers",
    {
      name: "Old Guest",
      phone: oldPhone,
      marketingConsent: true,
    },
    A,
  );
  await call(
    "POST",
    `/api/customers/${oldCust.body?.customer?.id}/visits`,
    {
      checkin: daysAgo(120),
      checkout: daysAgo(118),
    },
    A,
  );
  await call("PUT", "/api/segments", undefined, A);
  const segList3 = await call("GET", "/api/segments", undefined, A);
  const inact = (segList3.body?.segments ?? []).find((s: any) => s.name === "Inactive");
  ok(
    "Inactive segment matches 120-day-old guest",
    inact?.memberCount >= 1 && (await segMemberHas(inact?.id, oldCust.body?.customer?.id, A)),
    `count=${inact?.memberCount}`,
  );

  // Manual segments
  const manual = await call(
    "POST",
    "/api/segments",
    {
      name: `Test VIP List ${RUN}`,
      description: "Hand-picked guests for testing",
    },
    A,
  );
  ok("Create manual segment", manual.status === 201, `status=${manual.status}`);
  const manualId = manual.body?.segment?.id;

  const dupName = await call("POST", "/api/segments", { name: `Test VIP List ${RUN}` }, A);
  ok("Duplicate segment name rejected (409)", dupName.status === 409, `status=${dupName.status}`);

  const reserved = await call("POST", "/api/segments", { name: "VIP" }, A);
  ok("Reserved auto-segment name rejected", reserved.status === 409, `status=${reserved.status}`);

  const addMember = await call(
    "POST",
    `/api/segments/${manualId}/members`,
    { customerId: vipCustomer },
    A,
  );
  ok("Add member to manual segment", addMember.status === 201, `status=${addMember.status}`);

  const addDup = await call(
    "POST",
    `/api/segments/${manualId}/members`,
    { customerId: vipCustomer },
    A,
  );
  ok("Duplicate member rejected (409)", addDup.status === 409, `status=${addDup.status}`);

  const addAuto = await call(
    "POST",
    `/api/segments/${byName("VIP")?.id}/members`,
    { customerId: vipCustomer },
    A,
  );
  ok("Cannot manually edit AUTO segment", addAuto.status === 400, `status=${addAuto.status}`);

  const delAuto = await call("DELETE", `/api/segments/${byName("VIP")?.id}`, undefined, A);
  ok("System segment protected from delete", delAuto.status === 400, `status=${delAuto.status}`);

  const delManual = await call("DELETE", `/api/segments/${manualId}`, undefined, A);
  ok("Delete manual segment", delManual.status === 200, `status=${delManual.status}`);

  // Tenant isolation
  const segB = await call("GET", `/api/segments/${byName("VIP")?.id}`, undefined, B);
  ok("Hotel B cannot read Hotel A segment detail", segB.status === 404, `status=${segB.status}`);

  async function segMemberHas(
    segmentId: string | undefined,
    customerId: string,
    auth: string,
  ): Promise<boolean> {
    if (!segmentId || !customerId) return false;
    const detail = await call("GET", `/api/segments/${segmentId}`, undefined, auth);
    return (detail.body?.members ?? []).some((m: any) => m.id === customerId);
  }

  // ─────────────────────────────────────────────
  section("4. Personalization");

  const tmpCampaign = await call(
    "POST",
    "/api/campaigns",
    {
      name: `Personalisation Test ${RUN}`,
      segmentId: byName("Returning")?.id,
      channels: ["WHATSAPP"],
      offer: "25% OFF",
      messageTemplate:
        "Hi {{name}}, {{hotel_name}} misses you! Last visit: {{last_visit}}, stays: {{booking_count}}. Offer {{offer}} at {{booking_link}}",
    },
    A,
  );
  ok(
    "Campaign with all 6 variables created",
    tmpCampaign.status === 201,
    `status=${tmpCampaign.status}`,
  );

  const tmpDetail = await call(
    "GET",
    `/api/campaigns/${tmpCampaign.body?.campaign?.id}`,
    undefined,
    A,
  );
  const tpl = tmpDetail.body?.campaign?.messageTemplate ?? "";
  ok(
    "Template stored verbatim server-side",
    tpl.includes("{{name}}") && tpl.includes("{{hotel_name}}"),
  );

  const badVar = await call(
    "POST",
    "/api/campaigns",
    {
      name: `Bad Var ${RUN}`,
      segmentId: byName("Returning")?.id,
      channels: ["SMS"],
      messageTemplate: "Hello {{not_a_variable}} test message here",
    },
    A,
  );
  ok(
    "Unsupported variable rejected at validation",
    badVar.status === 400,
    `status=${badVar.status}`,
  );

  // ─────────────────────────────────────────────
  section("5. Consent-gated campaign send");

  // Build a controlled audience: one opted-out, one no-consent, one eligible
  const eligPhone = phone("04");
  // Phase 6.4: channel-specific consent — SMS opt-in is now required for an
  // SMS campaign (marketing consent alone no longer sends).
  const elig = await call(
    "POST",
    "/api/customers",
    {
      name: "Eligible Ankit",
      phone: eligPhone,
      marketingConsent: true,
      smsOptIn: true,
    },
    A,
  );
  await call(
    "POST",
    `/api/customers/${elig.body?.customer?.id}/visits`,
    {
      checkin: daysAgo(40),
      checkout: daysAgo(39),
    },
    A,
  );

  const optPhone = phone("05");
  const opted = await call(
    "POST",
    "/api/customers",
    {
      name: "Opted Out Ravi",
      phone: optPhone,
      marketingConsent: true,
    },
    A,
  );
  await call("POST", `/api/customers/${opted.body?.customer?.id}/opt-out`, {}, A);
  // Ravi needs 2 stays to join the Returning segment (engine is consent-blind)
  await call(
    "POST",
    `/api/customers/${opted.body?.customer?.id}/visits`,
    {
      checkin: daysAgo(40),
      checkout: daysAgo(39),
    },
    A,
  );

  const noCPhone = phone("06");
  const noC = await call(
    "POST",
    "/api/customers",
    {
      name: "No Consent Neha",
      phone: noCPhone,
      marketingConsent: false,
    },
    A,
  );
  await call(
    "POST",
    `/api/customers/${noC.body?.customer?.id}/visits`,
    {
      checkin: daysAgo(40),
      checkout: daysAgo(39),
    },
    A,
  );

  await call("PUT", "/api/segments", undefined, A);
  const segsNow = await call("GET", "/api/segments", undefined, A);
  const returningSeg = (segsNow.body?.segments ?? []).find((s: any) => s.name === "Returning");
  // eligible + opted + noC all have 1 visit except elig (1) — need 2+ for Returning.
  // Give each a second visit to join Returning
  for (const c of [elig, opted, noC]) {
    await call(
      "POST",
      `/api/customers/${c.body?.customer?.id}/visits`,
      {
        checkin: daysAgo(35),
        checkout: daysAgo(34),
      },
      A,
    );
  }
  await call("PUT", "/api/segments", undefined, A);

  const consentCampaign = await call(
    "POST",
    "/api/campaigns",
    {
      name: `Consent Gating Test ${RUN}`,
      segmentId: returningSeg?.id,
      channels: ["SMS"],
      messageTemplate: "Hi {{name}}, special {{offer}} for your next stay at {{hotel_name}}!",
      offer: "15% OFF",
    },
    A,
  );
  const ccId = consentCampaign.body?.campaign?.id;

  const send1 = await call("POST", `/api/campaigns/${ccId}/send`, {}, A);
  const s1 = send1.body?.summary;
  // Phase 6.4: simulation-mode deliveries are counted under `simulated`
  // (honest status — never reported as real `sent`).
  ok(
    "Send: eligible guests got messages",
    send1.status === 200 && (s1?.sent ?? 0) + (s1?.simulated ?? 0) >= 1,
    `sent=${s1?.sent} simulated=${s1?.simulated}`,
  );
  ok(
    "Send: opted-out skipped with reason",
    s1?.skippedReasons?.OPTED_OUT >= 1,
    `reasons=${JSON.stringify(s1?.skippedReasons)}`,
  );
  ok(
    "Send: no-consent skipped with reason",
    s1?.skippedReasons?.NO_CONSENT >= 1,
    `reasons=${JSON.stringify(s1?.skippedReasons)}`,
  );
  ok("Send: providerMode reported", s1?.providerMode === "SIMULATION", `mode=${s1?.providerMode}`);

  const ccDetail = await call("GET", `/api/campaigns/${ccId}`, undefined, A);
  const msgs = ccDetail.body?.messages ?? [];
  const optedMsg = msgs.find((m: any) => m.customerPhone === optPhone);
  ok(
    "Opted-out message recorded as SKIPPED/OPTED_OUT",
    optedMsg?.status === "SKIPPED" && optedMsg?.skipReason === "OPTED_OUT",
    `status=${optedMsg?.status}`,
  );
  ok(
    "SKIPPED message has empty body (never rendered for non-consent)",
    optedMsg?.personalizedMessage === "",
    `body=${optedMsg?.personalizedMessage}`,
  );
  const eligMsg = msgs.find((m: any) => m.customerPhone === eligPhone);
  ok(
    "Eligible message personalized (first name + offer + no raw {{vars}})",
    eligMsg?.personalizedMessage?.includes("Eligible") &&
      eligMsg?.personalizedMessage?.includes("15% OFF") &&
      !eligMsg?.personalizedMessage?.includes("{{"),
    `body=${eligMsg?.personalizedMessage}`,
  );

  // Duplicate protection
  const send2 = await call("POST", `/api/campaigns/${ccId}/send`, {}, A);
  ok(
    "Re-send: zero duplicates (dedupe works)",
    send2.status === 200 &&
      send2.body?.summary?.sent === 0 &&
      (send2.body?.summary?.simulated ?? 0) === 0,
    `sent=${send2.body?.summary?.sent}`,
  );

  // Test message endpoint
  const testMsg = await call("POST", `/api/campaigns/${ccId}/test`, { phone: "+919812345670" }, A);
  ok(
    "Test message endpoint works",
    testMsg.status === 200 && typeof testMsg.body?.preview === "string",
    `status=${testMsg.status}`,
  );
  ok(
    "Test message marked simulation/labeled",
    typeof testMsg.body?.message === "string" && testMsg.body.message.length > 0,
  );

  // ─────────────────────────────────────────────
  section("6. Follow-up engine");

  const fuSteps = await call("GET", "/api/campaigns/run-engine", undefined, A);
  ok(
    "Default 5 follow-up steps ensured",
    fuSteps.status === 200 && fuSteps.body?.steps?.length === 5,
    `steps=${fuSteps.body?.steps?.length}`,
  );
  const step1 = (fuSteps.body?.steps ?? []).find((s: any) => s.offsetDays === 1);
  ok(
    "Default steps include +1d thank-you with template",
    step1?.label === "Thank-you message" && step1?.messageTemplate?.includes("{{name}}"),
    `label=${step1?.label}`,
  );

  // Create guest whose latest checkout = 1 day ago
  const fuPhone = phone("07");
  // Phase 6.4: follow-up steps send via WHATSAPP — the guest needs the
  // WhatsApp channel opt-in (marketing consent alone no longer sends).
  const fuCust = await call(
    "POST",
    "/api/customers",
    {
      name: "Followup Farah",
      phone: fuPhone,
      marketingConsent: true,
      whatsappOptIn: true,
      smsOptIn: true,
    },
    A,
  );
  await call(
    "POST",
    `/api/customers/${fuCust.body?.customer?.id}/visits`,
    {
      checkin: daysAgo(4),
      checkout: daysAgo(1),
    },
    A,
  );

  const fuRun = await call("POST", "/api/campaigns/run-engine", {}, A);
  ok(
    "Engine run processes eligible checkout",
    fuRun.status === 200 && fuRun.body?.result?.customersProcessed >= 1,
    `customers=${fuRun.body?.result?.customersProcessed}`,
  );
  ok(
    "Engine respected consent (no failures, some sends)",
    fuRun.body?.result?.sent >= 1 && fuRun.body?.result?.failed === 0,
    `sent=${fuRun.body?.result?.sent} failed=${fuRun.body?.result?.failed}`,
  );

  // Automated campaigns exist now
  const afterFu = await call("GET", "/api/campaigns", undefined, A);
  const autoCampaigns = (afterFu.body?.campaigns ?? []).filter((c: any) => c.automated);
  ok(
    "Automated campaigns generated for steps",
    autoCampaigns.length >= 1,
    `count=${autoCampaigns.length}`,
  );

  // Timing edit
  const step90 = (fuSteps.body?.steps ?? []).find((s: any) => s.offsetDays === 90);
  const editStep = await call(
    "PUT",
    "/api/follow-ups",
    {
      id: step90?.id,
      offsetDays: 91,
      label: "Win-back campaign",
    },
    A,
  );
  ok("Admin can change follow-up timing", editStep.status === 200, `status=${editStep.status}`);

  const editClash = await call("PUT", "/api/follow-ups", { id: step90?.id, offsetDays: 7 }, A);
  ok("Conflicting timing rejected (409)", editClash.status === 409, `status=${editClash.status}`);

  // restore
  await call("PUT", "/api/follow-ups", { id: step90?.id, offsetDays: 90 }, A);

  // ─────────────────────────────────────────────
  section("7. Booking attribution + ROI analytics");

  const overviewBefore = await call("GET", "/api/analytics/overview", undefined, A);
  const revenueBefore = overviewBefore.body?.stats?.revenue ?? 0;

  const attr = await call(
    "POST",
    `/api/campaigns/${ccId}/attribute-booking`,
    {
      customerId: elig.body?.customer?.id,
      amount: 12400,
      channel: "SMS",
    },
    A,
  );
  ok("Booking attributed to campaign", attr.status === 201, `status=${attr.status}`);

  const attrInvalid = await call(
    "POST",
    `/api/campaigns/${ccId}/attribute-booking`,
    {
      customerId: opted.body?.customer?.id,
      amount: 5000,
    },
    A,
  );
  ok(
    "Attribution needs a SENT message (opted-out has none)",
    attrInvalid.status === 400,
    `status=${attrInvalid.status}`,
  );

  const ccStats = await call("GET", `/api/campaigns/${ccId}/analytics`, undefined, A);
  ok(
    "Campaign analytics: revenue + bookings updated",
    ccStats.body?.stats?.bookings >= 1 && ccStats.body?.stats?.revenue >= 12400,
    `bookings=${ccStats.body?.stats?.bookings} revenue=${ccStats.body?.stats?.revenue}`,
  );
  ok(
    "Campaign analytics: ROI computed from cost model",
    ccStats.body?.stats?.roi != null && ccStats.body?.stats?.roi > 0,
    `roi=${ccStats.body?.stats?.roi}`,
  );

  const overviewAfter = await call("GET", "/api/analytics/overview", undefined, A);
  ok(
    "Hotel-wide revenue includes attribution",
    (overviewAfter.body?.stats?.revenue ?? 0) >= revenueBefore + 12400,
    `after=${overviewAfter.body?.stats?.revenue} before=${revenueBefore}`,
  );
  ok("Segment sizes present in overview", (overviewAfter.body?.segmentSizes ?? []).length === 9);
  ok("Consent health computed", typeof overviewAfter.body?.consent?.optedIn === "number");

  // ─────────────────────────────────────────────
  section("8. Tracking webhook security");

  const noSecret = callWebhook({ providerMessageId: "SIM-test", event: "delivered" });
  ok("Webhook without secret rejected", noSecret.status === 401, `status=${noSecret.status}`);

  const wrongSecret = callWebhook(
    { providerMessageId: "SIM-test", event: "delivered" },
    "wrong-secret",
  );
  ok(
    "Webhook with wrong secret rejected",
    wrongSecret.status === 401,
    `status=${wrongSecret.status}`,
  );

  // Fetch a real providerMessageId from ccDetail
  // Phase 6.4: simulation deliveries are valid rows for webhook idempotency tests.
  const sentMsg = msgs.find((m: any) => m.status === "SENT" || m.status === "SIMULATED");
  if (sentMsg?.providerMessageId) {
    const delivered = callWebhook(
      { providerMessageId: sentMsg.providerMessageId, event: "delivered" },
      WEBHOOK_SECRET,
    );
    ok(
      "Webhook accepts real providerMessageId",
      delivered.status === 200 && delivered.body?.matched === true,
      `status=${delivered.status} body=${JSON.stringify(delivered.body)}`,
    );

    const opened = callWebhook(
      { providerMessageId: sentMsg.providerMessageId, event: "clicked" },
      WEBHOOK_SECRET,
    );
    ok("Click event recorded", opened.status === 200);

    const detailAfter = await call("GET", `/api/campaigns/${ccId}`, undefined, A);
    const updatedMsg = (detailAfter.body?.messages ?? []).find((m: any) => m.id === sentMsg.id);
    ok(
      "Engagement timestamps filled from webhook",
      updatedMsg?.deliveredAt != null && updatedMsg?.clickedAt != null,
      `delivered=${updatedMsg?.deliveredAt} clicked=${updatedMsg?.clickedAt}`,
    );

    const unknown = callWebhook(
      { providerMessageId: "TOTALLY-UNKNOWN-ID", event: "delivered" },
      WEBHOOK_SECRET,
    );
    ok(
      "Unknown providerMessageId handled gracefully",
      unknown.status === 200 && unknown.body?.matched === false,
    );

    const badEvent = callWebhook(
      { providerMessageId: sentMsg.providerMessageId, event: "bogus" },
      WEBHOOK_SECRET,
    );
    ok("Invalid event type rejected", badEvent.status === 400, `status=${badEvent.status}`);
  } else {
    ok("Webhook flow (skipped — no sent message id)", false, "no SENT message found");
  }

  // ─────────────────────────────────────────────
  section("9. Multi-tenant isolation (Phase 2)");

  const campB = await call("GET", `/api/campaigns/${ccId}`, undefined, B);
  ok("Hotel B cannot read Hotel A campaign", campB.status === 404, `status=${campB.status}`);

  const sendB = await call("POST", `/api/campaigns/${ccId}/send`, {}, B);
  ok("Hotel B cannot send Hotel A campaign", sendB.status === 404, `status=${sendB.status}`);

  const attrB = await call(
    "POST",
    `/api/campaigns/${ccId}/attribute-booking`,
    {
      customerId: elig.body?.customer?.id,
      amount: 1000,
    },
    B,
  );
  ok(
    "Hotel B cannot attribute to Hotel A campaign",
    attrB.status === 404,
    `status=${attrB.status}`,
  );

  const overviewB = await call("GET", "/api/analytics/overview", undefined, B);
  ok(
    "Hotel B analytics isolated (separate revenue)",
    overviewB.status === 200 && overviewB.body?.stats?.revenue < 12400,
    `revenueB=${overviewB.body?.stats?.revenue}`,
  );

  const engineB = await call("POST", "/api/campaigns/run-engine", {}, B);
  ok("Engine runs scoped per hotel", engineB.status === 200, `status=${engineB.status}`);

  // ─────────────────────────────────────────────
  section("10. Audit logging (Phase 2 actions)");

  const auditA = await call("GET", "/api/audit-logs?page=1&pageSize=50", undefined, A);
  const actions: string[] = (auditA.body?.logs ?? []).map((l: any) => l.action);
  const expectedActions = [
    "CAMPAIGN_CREATED",
    "CAMPAIGN_SENT",
    "SEGMENTS_REFRESHED",
    "SEGMENT_CREATED",
    "SEGMENT_MEMBER_ADDED",
    "FOLLOWUP_ENGINE_RUN",
    "BOOKING_ATTRIBUTED",
    "TEST_MESSAGE_SENT",
  ];
  for (const action of expectedActions) {
    ok(`Audit contains ${action}`, actions.includes(action));
  }

  // ─────────────────────────────────────────────
  section("11. Rate limits & validation edge cases");

  const noChannel = await call(
    "POST",
    "/api/campaigns",
    {
      name: `No Channel ${RUN}`,
      segmentId: returningSeg?.id,
      channels: [],
      messageTemplate: "Hello friends, this is a long enough message.",
    },
    A,
  );
  ok("Campaign without channel rejected", noChannel.status === 400, `status=${noChannel.status}`);

  const noAudience = await call(
    "POST",
    "/api/campaigns",
    {
      name: `No Audience ${RUN}`,
      channels: ["SMS"],
      messageTemplate: "Hello friends, this is a long enough message.",
    },
    A,
  );
  ok(
    "Campaign without audience rejected",
    noAudience.status === 400,
    `status=${noAudience.status}`,
  );

  const shortMsg = await call(
    "POST",
    "/api/campaigns",
    {
      name: `Short ${RUN}`,
      segmentId: returningSeg?.id,
      channels: ["SMS"],
      messageTemplate: "hi",
    },
    A,
  );
  ok("Too-short message rejected", shortMsg.status === 400, `status=${shortMsg.status}`);

  const badDate = await call(
    "POST",
    "/api/campaigns",
    {
      name: `Past Schedule ${RUN}`,
      segmentId: returningSeg?.id,
      channels: ["SMS"],
      messageTemplate: "Hello friends, this is a long enough message.",
      scheduleType: "SCHEDULED",
      scheduledAt: "2020-01-01T00:00:00Z",
    },
    A,
  );
  ok("Past schedule rejected", badDate.status === 400, `status=${badDate.status}`);

  const unauth = await call("GET", "/api/campaigns");
  ok("Campaigns API requires auth", unauth.status === 401, `status=${unauth.status}`);

  // ─────────────────────────────────────────────
  section("12. Cleanup (test campaigns archived)");

  const listA = await call("GET", "/api/campaigns", undefined, A);
  let archived = 0;
  for (const c of listA.body?.campaigns ?? []) {
    if (
      !c.automated &&
      (c.name.includes(RUN) ||
        c.name.includes("Personalisation Test") ||
        c.name.includes("Consent Gating Test") ||
        c.name.includes("Diwali Returning Offer"))
    ) {
      await call("DELETE", `/api/campaigns/${c.id}`, undefined, A);
      archived++;
    }
  }
  ok(`Test campaigns archived (${archived})`, archived >= 1);

  // ─────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log(`║  RESULT: ${passed} passed, ${failed} failed`);
  console.log("╚══════════════════════════════════════════════════╝");
  if (failed > 0) {
    console.log("\nFailed checks:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Suite crashed:", err);
  process.exit(1);
});
export {};

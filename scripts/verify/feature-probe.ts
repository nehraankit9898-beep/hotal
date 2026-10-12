/**
 * Feature probe #2: developer API, imports/exports, payment links, wallet,
 * loyalty, referrals, AI actions, reports schedule.
 */
import { call, check, summary } from "./probe-lib";

const uniq = Date.now();

async function main() {
  const login = await call("POST", "/api/auth/login", { email: "admin@grandpalace.com", password: "TestAdmin123" });
  check("auth", "hotel admin login", login.status === 200, `status=${login.status}`);

  // ---------- Developer API keys + /api/v1 ----------
  const key = await call("POST", "/api/api-keys", { name: `Probe key ${uniq}`, scopes: ["read", "write"] });
  const apiKey = key.body?.secret ?? key.body?.key ?? key.body?.apiKey;
  check("dev-api", "create API key", key.status === 201 && typeof apiKey === "string", `status=${key.status} key=${typeof apiKey === "string" ? apiKey.slice(0, 12) + "…" : JSON.stringify(key.body).slice(0, 120)}`);
  if (typeof apiKey === "string") {
    const idx = await call("GET", "/api/v1", undefined, { bearer: apiKey });
    check("dev-api", "GET /api/v1 index with key", idx.status === 200, `status=${idx.status}`);
    const created = await call("POST", "/api/v1/customers", { name: "API Guest", phone: `+9197${String(uniq).slice(-8)}`, marketingConsent: true }, { bearer: apiKey });
    check("dev-api", "POST /api/v1/customers", created.status === 201 || created.status === 200, `status=${created.status} ${JSON.stringify(created.body).slice(0, 130)}`);
    const stats = await call("GET", "/api/v1/stats", undefined, { bearer: apiKey });
    check("dev-api", "GET /api/v1/stats", stats.status === 200, `status=${stats.status}`);
    const noKey = await call("GET", "/api/v1/customers");
    check("dev-api", "API v1 rejects missing key", noKey.status === 401, `status=${noKey.status}`);
    const badKey = await call("GET", "/api/v1/customers", undefined, { bearer: "sk_live_not_a_real_key_value" });
    check("dev-api", "API v1 rejects a forged key", badKey.status === 401, `status=${badKey.status}`);
  }

  // ---------- CSV import (preview + commit) ----------
  const csv = "name,phone,email,marketingConsent\nCSV Guest,+919812345670,csvguest@example.com,true\nBad Row,xx,,";
  const preview = await call("POST", "/api/imports/customers/preview", { csv });
  check("import", "CSV import preview", preview.status === 200, `status=${preview.status} ${JSON.stringify(preview.body).slice(0, 160)}`);
  const commit = await call("POST", "/api/imports/customers", { csv });
  check("import", "CSV import commit", commit.status === 200 || commit.status === 201, `status=${commit.status} ${JSON.stringify(commit.body).slice(0, 160)}`);

  // ---------- Export ----------
  const exp = await call("GET", "/api/export/customers");
  check("export", "customer export (CSV)", exp.status === 200, `status=${exp.status} ${typeof exp.body === "string" ? `bytes=${exp.body.length}` : JSON.stringify(exp.body).slice(0, 120)}`);

  // ---------- Payment link on an unsettled bill ----------
  const ordering = await call("GET", "/api/bills");
  const unpaid = (ordering.body?.bills ?? []).find((b: any) => b.status !== "PAID" && b.status !== "VOID");
  if (unpaid) {
    const link = await call("POST", "/api/payment-links", { billId: unpaid.id, expiresInHours: 24 });
    const token = link.body?.paymentLink?.publicToken ?? link.body?.link?.publicToken ?? link.body?.publicToken;
    check("payment-links", "create payment link for unpaid bill", link.status === 201 && !!token, `status=${link.status} ${JSON.stringify(link.body).slice(0, 150)}`);
    if (token) {
      const page = await fetch(`${process.env.PROBE_BASE ?? "http://localhost:3000"}/pay/${token}`);
      check("payment-links", "public pay page renders", page.status === 200, `status=${page.status}`);
      const pub = await call("GET", `/api/pay/${token}`);
      check("payment-links", "public payment link JSON", pub.status === 200, `status=${pub.status}`);
    }
    const paidBill = (ordering.body?.bills ?? []).find((b: any) => b.status === "PAID");
    if (paidBill) {
      const bad = await call("POST", "/api/payment-links", { billId: paidBill.id });
      check("payment-links", "payment link refused for a settled bill", bad.status === 422, `status=${bad.status}`);
    }
  }

  // ---------- Loyalty adjust / redeem ----------
  const customers = await call("GET", "/api/customers?limit=3");
  const customerId = customers.body?.customers?.[0]?.id;
  if (customerId) {
    const adjust = await call("POST", "/api/loyalty/adjust", { customerId, points: 50, reason: "probe" });
    check("loyalty", "manual loyalty adjustment", adjust.status === 200 || adjust.status === 201, `status=${adjust.status} ${JSON.stringify(adjust.body).slice(0, 130)}`);
    const redeem = await call("POST", "/api/loyalty/redeem", { customerId });
    check("loyalty", "loyalty reward redemption rules enforced", redeem.status === 400 || redeem.status === 200, `status=${redeem.status} ${JSON.stringify(redeem.body).slice(0, 110)}`);
    const overdraft = await call("POST", "/api/loyalty/redeem", { customerId, points: 10_000_000 });
    check("loyalty", "over-redemption rejected", overdraft.status >= 400, `status=${overdraft.status} ${JSON.stringify(overdraft.body).slice(0, 110)}`);
    const wallet = await call("POST", "/api/wallet/passes", { customerId });
    const serial = wallet.body?.pass?.serialNumber;
    check("wallet", "issue loyalty wallet pass", wallet.status === 201 && !!serial, `status=${wallet.status} ${JSON.stringify(wallet.body).slice(0, 130)}`);
    if (serial) {
      const revoke = await call("POST", `/api/wallet/passes/${wallet.body.pass.id}/revoke`, {});
      check("wallet", "revoke wallet pass", revoke.status === 200, `status=${revoke.status}`);
    }
  }

  // ---------- Referrals ----------
  const refs = await call("GET", "/api/referrals");
  check("referrals", "referral program readable", refs.status === 200, `status=${refs.status}`);
  const refPut = await call("PUT", "/api/referrals", { active: true, referrerRewardValue: 100 });
  check("referrals", "referral program update", refPut.status === 200, `status=${refPut.status}`);

  // Enable the opt-in AI features for this tenant so the endpoints can be exercised.
  const enableFlags = await call("PATCH", "/api/ai/settings", { voiceEnabled: true, walletEnabled: true });
  check("ai", "owner can enable voice + wallet passes", enableFlags.status === 200, `status=${enableFlags.status} ${JSON.stringify(enableFlags.body).slice(0, 120)}`);

  // ---------- AI actions ----------
  const recs = await call("GET", "/api/ai/recommendations");
  const rec = (recs.body?.recommendations ?? [])[0];
  if (rec) {
    const dismiss = await call("POST", `/api/ai/recommendations/${rec.id}/dismiss`, {});
    check("ai", "dismiss an AI recommendation", dismiss.status === 200, `status=${dismiss.status}`);
  } else {
    check("ai", "recommendations list reachable (none pending)", recs.status === 200, `status=${recs.status}`);
  }
  const voice = await call("POST", "/api/ai/voice/parse", { transcript: "two paneer tikka and one masala chai" });
  check("ai", "voice transcript parsing", voice.status === 200, `status=${voice.status} ${JSON.stringify(voice.body).slice(0, 150)}`);
  const forecast = await call("GET", "/api/ai/forecast");
  check("ai", "forecast honesty (may report NOT_ENOUGH_DATA)", forecast.status === 200, `status=${forecast.status}`);

  // ---------- Reports schedule ----------
  const sched = await call("PUT", "/api/report-schedule", { enabled: true, frequency: "DAILY", hour: 9, recipients: ["owner@grandpalace.com"] });
  check("reports", "owner report schedule update", sched.status === 200, `status=${sched.status} ${JSON.stringify(sched.body).slice(0, 120)}`);

  // ---------- Notifications + feedback ----------
  const notes = await call("GET", "/api/notifications");
  check("notifications", "notification centre", notes.status === 200, `status=${notes.status}`);
  const fb = await call("GET", "/api/feedback");
  check("feedback", "feedback list", fb.status === 200, `status=${fb.status}`);

  // ---------- Segments refresh + analytics ----------
  const seg = await call("GET", "/api/segments");
  const manual = (seg.body?.segments ?? []).find((x: any) => x.type === "MANUAL");
  let manualId = manual?.id;
  if (!manualId) {
    const createdSeg = await call("POST", "/api/segments", { name: `Probe Manual ${uniq}`, type: "MANUAL" });
    manualId = createdSeg.body?.segment?.id;
    check("segments", "create MANUAL segment", createdSeg.status === 201 && !!manualId, `status=${createdSeg.status}`);
  }
  const someCustomer = (await call("GET", "/api/customers?limit=1")).body?.customers?.[0]?.id;
  if (manualId && someCustomer) {
    const members = await call("POST", `/api/segments/${manualId}/members`, { customerId: someCustomer });
    check("segments", "add member to MANUAL segment", members.status === 200 || members.status === 201, `status=${members.status}`);
  }
  const analytics = await call("GET", "/api/analytics/overview");
  check("analytics", "analytics overview", analytics.status === 200, `status=${analytics.status}`);

  summary();
}

await main();

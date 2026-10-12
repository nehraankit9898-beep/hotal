import { call, check, summary } from "./probe-lib";

const BASE = process.env.PROBE_BASE ?? "http://localhost:3000";
const login = await call("POST", "/api/auth/login", { email: "admin@grandpalace.com", password: "TestAdmin123" });
check("auth", "login", login.status === 200, `status=${login.status}`);
const qr = await call("GET", "/api/qr-codes");
const codes = qr.body?.qrCodes ?? [];
const menuCode = codes.find((c: any) => c.type === "MENU")?.code;
const feedbackCode = codes.find((c: any) => c.type === "FEEDBACK")?.code;
const loyaltyCode = codes.find((c: any) => c.type === "LOYALTY")?.code;
check("qr", "seeded QR codes exist (MENU/FEEDBACK/LOYALTY)", !!menuCode && !!feedbackCode && !!loyaltyCode, `menu=${!!menuCode} feedback=${!!feedbackCode} loyalty=${!!loyaltyCode}`);

for (const [label, url] of [
  ["public menu page", `/menu/${menuCode}`],
  ["public feedback page", `/r/${feedbackCode}`],
  ["public loyalty join page", `/r/${loyaltyCode}`],
] as [string, string][]) {
  if (!url.includes("undefined")) {
    const res = await fetch(`${BASE}${url}`);
    const html = await res.text();
    check("pages", `${label} renders (${url.slice(0, 24)}…)`, res.status === 200 && html.includes("<html"), `status=${res.status} bytes=${html.length}`);
  }
}

// API: public menu + feedback submission on the public surface
const pubMenu = await call("GET", `/api/public/menu/${menuCode}`);
check("public-api", "public menu JSON", pubMenu.status === 200, `status=${pubMenu.status}`);
const pubFeedback = await call("POST", "/api/public/feedback", { qrCode: feedbackCode, rating: 5, comment: "probe" });
check("public-api", "guest feedback submitted", pubFeedback.status === 200 || pubFeedback.status === 201 || pubFeedback.status === 409, `status=${pubFeedback.status}`);
const badQr = await call("GET", "/api/public/menu/definitely-not-a-real-code-000");
check("public-api", "invalid QR code rejected (400/404)", badQr.status === 400 || badQr.status === 404, `status=${badQr.status}`);
const dashHtml = await fetch(`${BASE}/`);
const html = await dashHtml.text();
check("pages", "root page serves the app shell", dashHtml.status === 200 && html.includes("<html"), `status=${dashHtml.status} bytes=${html.length}`);
summary();

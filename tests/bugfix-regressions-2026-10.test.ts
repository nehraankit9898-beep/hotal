/**
 * Regression tests for the October 2026 bug sweep. No server, no queries:
 * `./queue-test-env` (first import) points the db singleton at a throwaway
 * SQLite file so DB-backed modules can be imported safely.
 *
 *  - Day window   the sales report and the owner daily report used a
 *                 "local day" that was 12:00 UTC → 23:59 UTC next day (36h)
 *                 for every timezone
 *  - Promotions   day-restricted promotions never applied ("MON" vs "Mon")
 *  - Consent      the bill thank-you / review email ignored optOut and the
 *                 email channel opt-in
 *  - Inventory    a PO listing one ingredient on two lines received only the
 *                 first line
 *  - Webhooks     outbound deliveries followed redirects and production
 *                 accepted internal / private hosts (SSRF)
 *  - Test runner  suites missing from scripts/run-tests.ts never ran in CI
 *  - .gitignore   an unanchored `backups/` rule kept the Super Admin backups
 *                 API route out of git (404 in every build from the repo)
 */
import "./queue-test-env";
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import { zonedDayBounds } from "../src/lib/timezone";
import { localDayBounds, billThankYouSkipReason } from "../src/lib/retention";
import { promotionWindowOpen } from "../src/lib/billing";
import { aggregateReceiptLines } from "../src/lib/inventory";
import { isBlockedWebhookHost, validateWebhookUrl } from "../src/lib/webhooks-out";

const ROOT = join(import.meta.dir, "..");
const iso = (d: Date) => d.toISOString();

describe("tenant-local day bounds (sales report + owner daily report)", () => {
  test("Asia/Kolkata: the day starts at local midnight (18:30 UTC the evening before)", () => {
    const { start, end } = zonedDayBounds("2026-10-12", "Asia/Kolkata");
    expect(iso(start)).toBe("2026-10-11T18:30:00.000Z");
    expect(iso(end)).toBe("2026-10-12T18:30:00.000Z");
  });

  test("UTC: exactly the calendar day", () => {
    const { start, end } = zonedDayBounds("2026-10-12", "UTC");
    expect(iso(start)).toBe("2026-10-12T00:00:00.000Z");
    expect(iso(end)).toBe("2026-10-13T00:00:00.000Z");
  });

  test("DST days are 23h / 25h long (America/New_York)", () => {
    const spring = zonedDayBounds("2026-03-08", "America/New_York");
    expect(iso(spring.start)).toBe("2026-03-08T05:00:00.000Z");
    expect(iso(spring.end)).toBe("2026-03-09T04:00:00.000Z");
    const autumn = zonedDayBounds("2026-11-01", "America/New_York");
    expect(iso(autumn.start)).toBe("2026-11-01T04:00:00.000Z");
    expect(iso(autumn.end)).toBe("2026-11-02T05:00:00.000Z");
  });

  test("month / year rollover", () => {
    const { start, end } = zonedDayBounds("2026-12-31", "Asia/Kolkata");
    expect(iso(start)).toBe("2026-12-30T18:30:00.000Z");
    expect(iso(end)).toBe("2026-12-31T18:30:00.000Z");
  });

  test("consecutive days tile without gaps or overlap", () => {
    const d1 = zonedDayBounds("2026-10-12", "Asia/Dubai");
    const d2 = zonedDayBounds("2026-10-13", "Asia/Dubai");
    expect(d1.end.getTime()).toBe(d2.start.getTime());
  });

  test("owner daily report uses the same bounds", () => {
    expect(localDayBounds("2026-10-12", "Asia/Kolkata")).toEqual(zonedDayBounds("2026-10-12", "Asia/Kolkata"));
  });

  test("the sales report route uses the shared helper (no private day math)", () => {
    const src = readFileSync(join(ROOT, "src/app/api/reports/sales/route.ts"), "utf8");
    expect(src).toContain("zonedDayBounds(dateStr, tz)");
    expect(src).not.toContain("function localDayBounds");
  });
});

describe("promotion day/time windows", () => {
  // 2026-10-12 is a Monday; 13:30 UTC = 19:00 IST.
  const mondayEvening = new Date("2026-10-12T13:30:00Z");
  const tz = "Asia/Kolkata";
  const promo = (over: Partial<Parameters<typeof promotionWindowOpen>[0]>) => ({
    type: "PERCENT",
    daysOfWeek: null,
    startTime: null,
    endTime: null,
    ...over,
  });

  test("days stored as MON..SUN (API/UI format) match the current local day", () => {
    expect(promotionWindowOpen(promo({ daysOfWeek: JSON.stringify(["MON"]) }), mondayEvening, tz)).toBe(true);
    expect(
      promotionWindowOpen(
        promo({ daysOfWeek: JSON.stringify(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]) }),
        mondayEvening,
        tz,
      ),
    ).toBe(true);
  });

  test("other days do not match; the weekday is taken in the tenant timezone", () => {
    expect(promotionWindowOpen(promo({ daysOfWeek: JSON.stringify(["TUE", "SUN"]) }), mondayEvening, tz)).toBe(false);
    // 20:00 UTC Monday is already Tuesday 01:30 in India.
    const lateUtc = new Date("2026-10-12T20:00:00Z");
    expect(promotionWindowOpen(promo({ daysOfWeek: JSON.stringify(["TUE"]) }), lateUtc, tz)).toBe(true);
  });

  test("no restriction / empty list applies every day; malformed JSON never applies", () => {
    expect(promotionWindowOpen(promo({}), mondayEvening, tz)).toBe(true);
    expect(promotionWindowOpen(promo({ daysOfWeek: "[]" }), mondayEvening, tz)).toBe(true);
    expect(promotionWindowOpen(promo({ daysOfWeek: "not json" }), mondayEvening, tz)).toBe(false);
  });

  test("happy-hour windows (incl. overnight) still evaluate in local time", () => {
    const hh = (startTime: string, endTime: string) => promo({ type: "HAPPY_HOUR", startTime, endTime });
    expect(promotionWindowOpen(hh("18:00", "20:00"), mondayEvening, tz)).toBe(true);
    expect(promotionWindowOpen(hh("19:01", "20:00"), mondayEvening, tz)).toBe(false);
    expect(promotionWindowOpen(hh("22:00", "02:00"), new Date("2026-10-12T19:30:00Z"), tz)).toBe(true); // 01:00 IST
    expect(promotionWindowOpen(promo({ type: "HAPPY_HOUR" }), mondayEvening, tz)).toBe(false);
  });
});

describe("bill thank-you / review email consent", () => {
  const consented = {
    email: "guest@example.com",
    marketingConsent: true,
    optOut: false,
    whatsappOptIn: false,
    smsOptIn: false,
    emailOptIn: true,
  };

  test("fully consented customer receives it", () => {
    expect(billThankYouSkipReason(consented)).toBeNull();
  });
  test("a STOP reply (optOut only — marketingConsent untouched) suppresses it", () => {
    expect(billThankYouSkipReason({ ...consented, optOut: true })).toBe("opted_out");
  });
  test("revoking just the email channel suppresses it", () => {
    expect(billThankYouSkipReason({ ...consented, emailOptIn: false })).toBe("no_consent");
  });
  test("no marketing consent / no email / unknown customer", () => {
    expect(billThankYouSkipReason({ ...consented, marketingConsent: false })).toBe("no_consent");
    expect(billThankYouSkipReason({ ...consented, email: null })).toBe("no_email");
    expect(billThankYouSkipReason(null)).toBe("no_email");
  });
});

describe("purchase-order goods receipt", () => {
  test("lines for the same ingredient are merged (qty summed, weighted unit cost)", () => {
    const merged = aggregateReceiptLines([
      { ingredientId: "tomato", qty: 5000, unitCostMinor: 4 },
      { ingredientId: "onion", qty: 1000, unitCostMinor: 3 },
      { ingredientId: "tomato", qty: 2000, unitCostMinor: 5 },
    ]);
    expect(merged).toEqual([
      { ingredientId: "tomato", qty: 7000, unitCostMinor: 4 }, // (20000 + 10000) / 7000 = 4.29
      { ingredientId: "onion", qty: 1000, unitCostMinor: 3 },
    ]);
  });
  test("a single line keeps its exact unit cost", () => {
    expect(aggregateReceiptLines([{ ingredientId: "ghee", qty: 0.5, unitCostMinor: 33 }])).toEqual([
      { ingredientId: "ghee", qty: 0.5, unitCostMinor: 33 },
    ]);
  });
});

describe("outbound webhook destinations (SSRF)", () => {
  test("production rejects loopback, private, link-local and local-only hosts", () => {
    for (const url of [
      "https://127.0.0.1/hook",
      "https://2130706433/hook", // decimal form of 127.0.0.1
      "https://localhost/hook",
      "https://api.localhost/hook",
      "https://10.1.2.3/hook",
      "https://172.16.0.9/hook",
      "https://192.168.1.10/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://100.64.0.1/hook",
      "https://0.0.0.0/hook",
      "https://[::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[fd00::1]/hook",
      "https://[fe80::1]/hook",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://printer.local/hook",
    ]) {
      expect({ url, ok: validateWebhookUrl(url, true) }).toEqual({ url, ok: false });
    }
  });

  test("production accepts public https endpoints only", () => {
    expect(validateWebhookUrl("https://hooks.example.com/stayloop", true)).toBe(true);
    expect(validateWebhookUrl("https://8.8.8.8/hook", true)).toBe(true);
    expect(validateWebhookUrl("http://hooks.example.com/stayloop", true)).toBe(false);
  });

  test("dev/test keeps loopback for contract tests", () => {
    expect(validateWebhookUrl("http://127.0.0.1:4010/hook", false)).toBe(true);
  });

  test("resolved-address classification", () => {
    expect(isBlockedWebhookHost("172.15.255.255")).toBe(false);
    expect(isBlockedWebhookHost("172.31.0.1")).toBe(true);
    expect(isBlockedWebhookHost("100.128.0.1")).toBe(false);
    expect(isBlockedWebhookHost("224.0.0.1")).toBe(true);
    expect(isBlockedWebhookHost("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedWebhookHost("::ffff:10.0.0.1")).toBe(true);
  });

  test("deliveries do not follow redirects (the 3xx → dead-letter branch is reachable)", () => {
    const src = readFileSync(join(ROOT, "src/lib/webhooks-out.ts"), "utf8");
    const fetchCall = src.slice(src.indexOf("await fetch(delivery.endpoint.url"));
    expect(fetchCall.slice(0, fetchCall.indexOf("});"))).toContain('redirect: "manual"');
  });
});

describe("repository hygiene", () => {
  test("the Super Admin backups route is present and not git-ignored", () => {
    const route = "src/app/api/super-admin/backups/route.ts";
    expect(existsSync(join(ROOT, route))).toBe(true);
    const check = spawnSync("git", ["check-ignore", "-q", "--no-index", route], { cwd: ROOT });
    if (check.error || check.status === 128) return; // no git / not a checkout
    expect(check.status).toBe(1); // 1 = not ignored
  });

  test("every tests/*.test.ts suite is listed in scripts/run-tests.ts", () => {
    const runner = readFileSync(join(ROOT, "scripts/run-tests.ts"), "utf8");
    const missing = readdirSync(join(ROOT, "tests"))
      .filter((f) => f.endsWith(".test.ts"))
      .filter((f) => !runner.includes(`"tests/${f}"`));
    expect(missing).toEqual([]);
  });
});

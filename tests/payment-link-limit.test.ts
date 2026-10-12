import { test, expect } from "bun:test";
import { limitPaymentLinkRequest } from "@/lib/payment-link-limit";

test("public checkout limit denies excess calls with Retry-After (in-process fallback)", async () => {
  const req = new Request("http://localhost/api/pay/fake/checkout", {
    method: "POST", headers: { "x-forwarded-for": "203.0.113.127" },
  });
  for (let n = 0; n < 10; n++) expect(await limitPaymentLinkRequest(req, "checkout")).toBeNull();
  const rejected = await limitPaymentLinkRequest(req, "checkout");
  expect(rejected?.status).toBe(429);
  expect(Number(rejected?.headers.get("Retry-After"))).toBeGreaterThan(0);
  // Independent route budgets: do not block payment verification after a
  // checkout burst (customer may be returning from a legitimate redirect).
  expect(await limitPaymentLinkRequest(req, "verify")).toBeNull();
});

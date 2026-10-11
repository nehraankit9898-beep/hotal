/**
 * Phase 22 — brute-force lockout tests (dedicated accounts, run isolated).
 */
import { describe, test, expect } from "bun:test";
import { BASE, apiCall, login } from "./helpers";

describe("Brute force / account lockout (Phase 10)", () => {
  test("5 failed logins lock the account; correct password is refused while locked", async () => {
    // dedicated victim — locking it must not affect other tests
    const email = `lock${Date.now()}@victim.test`;
    const reg = await apiCall("POST", "/api/hotels", {
      body: {
        hotelName: "Lockout Test Hotel",
        adminName: "Lock Admin",
        email,
        password: "GoodPass123",
      },
    });
    expect(reg.status).toBe(201);

    let lastStatus = 0;
    for (let i = 0; i < 5; i++) {
      const { res } = await login(email, "BadPass123");
      lastStatus = res.status;
      // the 5th failed attempt is the one that triggers the lock → 423
      expect([401, 423]).toContain(res.status);
    }
    expect(lastStatus).toBe(423);
    // further attempts — even with the CORRECT password — stay locked (423)
    const locked = await login(email, "GoodPass123");
    expect(locked.res.status).toBe(423);
    expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");
  });
});

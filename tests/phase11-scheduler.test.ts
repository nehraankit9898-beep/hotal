/**
 * Phase 11 — durable scheduler regression tests (direct-DB, no HTTP).
 *
 * Covers the three sweeps added to the standalone worker:
 *   1. sweepDueCampaigns — a due SCHEDULED campaign is claimed + enqueued
 *      EXACTLY ONCE (a second sweep enqueues nothing; a future campaign is
 *      untouched; a suspended tenant's campaign is skipped).
 *   2. enrollJourneyCustomer — idempotent per customer; cross-tenant
 *      enrollment is rejected.
 *   3. sweepJourneys — one delivery reservation per step/customer/occurrence
 *      (unique constraint), consent-blocked customers get SKIPPED (not SENT),
 *      the enrollment cursor advances, and a re-run never duplicates.
 */
import "./queue-test-env";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { QUEUE_TEST_TMP, cleanupQueueTestTmp } from "./queue-test-env";

const db = new PrismaClient({
  datasources: { db: { url: `${process.env.DATABASE_URL}?connection_limit=1` } },
});

import { sweepDueCampaigns, enrollJourneyCustomer, sweepJourneys } from "../src/lib/scheduler";

const HOTEL = "hotel-sched-1";
const HOTEL_SUSPENDED = "hotel-sched-suspended";
const OTHER_HOTEL = "hotel-sched-2";

beforeAll(async () => {
  // Push the REAL schema into the throwaway SQLite DB (same approach the
  // harness uses for the HTTP server's database) — robust against model
  // evolution, no hand-maintained DDL to drift.
  const { spawnSync } = await import("child_process");
  const push = spawnSync(
    "bunx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      stdio: "pipe",
    },
  );
  if (push.status !== 0) {
    throw new Error("prisma db push failed: " + push.stderr.toString().slice(-500));
  }

  const now = new Date().toISOString();
  await db.hotel.createMany({
    data: [
      { id: HOTEL, name: "Sched Hotel", status: "ACTIVE", updatedAt: new Date(now) },
      { id: HOTEL_SUSPENDED, name: "Suspended Hotel", status: "SUSPENDED", updatedAt: new Date(now) },
      { id: OTHER_HOTEL, name: "Other Hotel", status: "ACTIVE", updatedAt: new Date(now) },
    ],
  });
});

afterAll(async () => {
  await db.$disconnect();
  cleanupQueueTestTmp();
});

describe("Phase 11 — sweepDueCampaigns (due scheduled campaigns)", () => {
  test("due campaign is dispatched EXACTLY ONCE; future + suspended-tenant campaigns untouched", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.campaign.create({
      data: {
        id: "camp-due",
        hotelId: HOTEL,
        name: "Due campaign",
        status: "SCHEDULED",
        scheduleType: "SCHEDULED",
        scheduledAt: past,
        channels: '["WHATSAPP"]',
        messageTemplate: "hi",
      },
    });
    await db.campaign.create({
      data: {
        id: "camp-future",
        hotelId: HOTEL,
        name: "Future campaign",
        status: "SCHEDULED",
        scheduleType: "SCHEDULED",
        scheduledAt: future,
        channels: '["WHATSAPP"]',
        messageTemplate: "hi",
      },
    });
    await db.campaign.create({
      data: {
        id: "camp-suspended",
        hotelId: HOTEL_SUSPENDED,
        name: "Suspended tenant campaign",
        status: "SCHEDULED",
        scheduleType: "SCHEDULED",
        scheduledAt: past,
        channels: '["WHATSAPP"]',
        messageTemplate: "hi",
      },
    });

    const first = await sweepDueCampaigns();
    expect(first).toBe(1); // only the due, active-tenant campaign

    const dueCampaign = await db.campaign.findUnique({ where: { id: "camp-due" } });
    expect(dueCampaign?.status).toBe("ACTIVE"); // claimed

    const jobs = await db.backgroundJob.findMany({
      where: { type: "CAMPAIGN_SEND", hotelId: HOTEL },
    });
    expect(jobs.length).toBe(1); // enqueued exactly once
    const payload = JSON.parse(jobs[0].payload);
    expect(payload.campaignId).toBe("camp-due");

    // Second sweep (restart / second worker): nothing left to dispatch.
    const second = await sweepDueCampaigns();
    expect(second).toBe(0);
    const jobsAfter = await db.backgroundJob.findMany({
      where: { type: "CAMPAIGN_SEND", hotelId: HOTEL },
    });
    expect(jobsAfter.length).toBe(1); // still exactly one job

    // Future + suspended campaigns untouched.
    expect((await db.campaign.findUnique({ where: { id: "camp-future" } }))?.status).toBe("SCHEDULED");
    expect((await db.campaign.findUnique({ where: { id: "camp-suspended" } }))?.status).toBe("SCHEDULED");
  });
});

describe("Phase 11 — journey enrollment", () => {
  test("idempotent per customer; cross-tenant enrollment rejected", async () => {
    await db.journey.create({
      data: { id: "j-1", hotelId: HOTEL, name: "Welcome journey", enabled: true },
    });
    await db.journeyStep.create({
      data: {
        id: "js-1",
        journeyId: "j-1",
        // Far-future offset: this enrollment must stay DORMANT so later
        // sweep assertions only see their own fixtures.
        offsetDays: 365,
        label: "Day 365",
        messageTemplate: "Welcome!",
        channels: '["WHATSAPP"]',
        sortOrder: 0,
      },
    });
    await db.customer.createMany({
      data: [
        { id: "cust-1", hotelId: HOTEL, name: "Asha", phone: "9999999999" },
        { id: "cust-other", hotelId: OTHER_HOTEL, name: "Ravi", phone: "8888888888" },
      ],
    });

    const first = await enrollJourneyCustomer("j-1", "cust-1", HOTEL);
    expect(first.ok).toBe(true);
    expect(first.already).toBeUndefined();

    // Repeat enrollment → no-op with already=true (unique constraint).
    const second = await enrollJourneyCustomer("j-1", "cust-1", HOTEL);
    expect(second.ok).toBe(true);
    expect(second.already).toBe(true);

    // Cross-tenant customer → rejected.
    const cross = await enrollJourneyCustomer("j-1", "cust-other", HOTEL);
    expect(cross.ok).toBe(false);

    // Cross-tenant journey (wrong hotel for the caller) → rejected.
    const wrongJourney = await enrollJourneyCustomer("j-1", "cust-1", OTHER_HOTEL);
    expect(wrongJourney.ok).toBe(false);
  });
});

describe("Phase 11 — sweepJourneys (exactly-once step delivery)", () => {
  test("consent-blocked customer: SKIPPED, cursor advances, re-run does not duplicate", async () => {
    // opt-out customer → delivery must be SKIPPED (never SENT), and the
    // enrollment must advance so the step is never retried for this occurrence.
    await db.customer.create({
      data: {
        id: "cust-optout",
        hotelId: HOTEL,
        name: "Opted Out",
        phone: "7777777777",
        optOut: true,
        marketingConsent: false,
      },
    });
    await db.journey.create({
      data: { id: "j-2", hotelId: HOTEL, name: "Winback", enabled: true },
    });
    await db.journeyStep.createMany({
      data: [
        {
          id: "js-2a",
          journeyId: "j-2",
          offsetDays: 0,
          label: "Step 1",
          messageTemplate: "hello",
          channels: '["WHATSAPP"]',
          sortOrder: 0,
        },
        {
          id: "js-2b",
          journeyId: "j-2",
          offsetDays: 30,
          label: "Step 2",
          messageTemplate: "again",
          channels: '["WHATSAPP"]',
          sortOrder: 1,
        },
      ],
    });

    const enrolled = await enrollJourneyCustomer("j-2", "cust-optout", HOTEL);
    expect(enrolled.ok).toBe(true);

    // Force step 0 due now.
    await db.journeyEnrollment.updateMany({
      where: { journeyId: "j-2", customerId: "cust-optout" },
      data: { nextStepAt: new Date(Date.now() - 1000) },
    });

    const result = await sweepJourneys();
    expect(result.skipped).toBe(1); // consent-blocked
    expect(result.sent).toBe(0);

    let enrollment = await db.journeyEnrollment.findFirst({
      where: { journeyId: "j-2", customerId: "cust-optout" },
    });
    expect(enrollment?.nextStepIndex).toBe(1); // advanced past step 0

    const deliveries = await db.journeyStepDelivery.findMany({
      where: { customerId: "cust-optout" },
    });
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe("SKIPPED");
    expect(deliveries[0].error).toBe("CONSENT");

    // Force step 1 due as well, then a FULL re-run: step 0 must not be
    // re-delivered (occurrence unique), step 1 gets its own reservation.
    await db.journeyEnrollment.updateMany({
      where: { journeyId: "j-2", customerId: "cust-optout" },
      data: { nextStepAt: new Date(Date.now() - 1000) },
    });
    await sweepJourneys();
    const deliveriesAfter = await db.journeyStepDelivery.findMany({
      where: { customerId: "cust-optout" },
    });
    expect(deliveriesAfter.length).toBe(2); // one per step — no duplicates

    enrollment = await db.journeyEnrollment.findFirst({
      where: { journeyId: "j-2", customerId: "cust-optout" },
    });
    expect(enrollment?.status).toBe("COMPLETED"); // all steps processed
  });

  test("PAUSED enrollment is not advanced", async () => {
    await db.customer.create({
      data: {
        id: "cust-paused",
        hotelId: HOTEL,
        name: "Paused",
        phone: "6666666666",
        marketingConsent: true,
      },
    });
    await db.journey.create({
      data: { id: "j-3", hotelId: HOTEL, name: "Paused Journey", enabled: true },
    });
    await db.journeyStep.create({
      data: {
        id: "js-3a",
        journeyId: "j-3",
        offsetDays: 0,
        label: "Step 1",
        messageTemplate: "hi",
        channels: '["WHATSAPP"]',
        sortOrder: 0,
      },
    });
    await enrollJourneyCustomer("j-3", "cust-paused", HOTEL);
    await db.journeyEnrollment.updateMany({
      where: { journeyId: "j-3", customerId: "cust-paused" },
      data: { nextStepAt: new Date(Date.now() - 1000), status: "PAUSED" },
    });

    const result = await sweepJourneys();
    expect(result.sent + result.skipped + result.failed).toBe(0); // paused → untouched

    const deliveries = await db.journeyStepDelivery.findMany({
      where: { customerId: "cust-paused" },
    });
    expect(deliveries.length).toBe(0); // no delivery reserved while paused
  });
});

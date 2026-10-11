/**
 * Cleanup script — removes test-suite artifacts and re-seeds clean demo data.
 * Run: bun run scripts/cleanup-reseed.ts
 */
import { db } from "../src/lib/db";

async function main() {
  console.log("🧹 Cleaning test artifacts...");

  // Remove test hotels created by test suites (Sunrise Hotel / sunrise*@test.com)
  const testHotels = await db.hotel.findMany({
    where: { OR: [{ name: "Sunrise Hotel" }, { email: { contains: "@test.com" } }] },
    select: { id: true, name: true, email: true },
  });
  for (const h of testHotels) {
    // cascade deletes users, customers, visits, campaigns, etc.
    await db.hotel.delete({ where: { id: h.id } });
    console.log(`  - deleted test hotel: ${h.name} (${h.email})`);
  }

  // Remove test customers in real hotels (XSS payloads, test names)
  const testCustomers = await db.customer.findMany({
    where: {
      OR: [
        { name: { contains: "Test" } },
        { name: { contains: "<script>" } },
        { email: { contains: "@test.com" } },
        { phone: { contains: "99999" } },
      ],
    },
    select: { id: true, name: true },
  });
  for (const c of testCustomers) {
    await db.customer.delete({ where: { id: c.id } });
    console.log(`  - deleted test customer: ${c.name}`);
  }

  // Remove consent-gating / personalisation test campaigns
  const testCampaigns = await db.campaign.findMany({
    where: {
      OR: [
        { name: { contains: "Consent Gating Test" } },
        { name: { contains: "Personalisation Test" } },
        { name: { contains: "Test" } },
      ],
    },
    select: { id: true, name: true },
  });
  for (const c of testCampaigns) {
    await db.campaign.delete({ where: { id: c.id } });
    console.log(`  - deleted test campaign: ${c.name}`);
  }

  // Remove test segments (manual test segments)
  const testSegments = await db.segment.findMany({
    where: { AND: [{ type: "MANUAL" }, { name: { contains: "Test" } }] },
    select: { id: true, name: true },
  });
  for (const s of testSegments) {
    await db.segment.delete({ where: { id: s.id } });
    console.log(`  - deleted test segment: ${s.name}`);
  }

  // Remove LOGIN_FAILED noise from rate-limit tests
  await db.auditLog.deleteMany({ where: { action: "LOGIN_FAILED" } });
  console.log("  - purged LOGIN_FAILED audit noise");

  const counts = {
    hotels: await db.hotel.count(),
    users: await db.user.count(),
    customers: await db.customer.count(),
    visits: await db.visit.count(),
    campaigns: await db.campaign.count(),
    coupons: await db.coupon.count(),
    restaurantVisits: await db.restaurantVisit.count(),
  };
  console.log("✅ Clean state:", counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });

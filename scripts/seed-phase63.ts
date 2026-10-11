/**
 * Phase 6.3 seed script — loyalty, QR codes, feedback, message templates,
 * hotel settings (marketing frequency + consent text).
 *
 * Run AFTER the main seeds:
 *   bun run scripts/seed.ts && bun run scripts/seed-phase3-6.ts && bun run scripts/seed-phase63.ts
 *
 * Idempotent: safe to re-run.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import { DEFAULT_TEMPLATES } from "../src/lib/templates";

const db = new PrismaClient();

function daysAgo(n: number, hour = 12): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function qrCode(): string {
  return randomBytes(24).toString("base64url");
}

async function main() {
  console.log("→ Phase 6.3 seed: loyalty, QR codes, feedback, templates…");
  const hotels = await db.hotel.findMany({ orderBy: { createdAt: "asc" } });
  if (hotels.length === 0) {
    console.log("No hotels found. Run scripts/seed.ts first.");
    return;
  }

  for (const hotel of hotels) {
    // ---- Hotel settings (frequency control + consent text) ----------------
    await db.hotelSettings.upsert({
      where: { hotelId: hotel.id },
      create: {
        hotelId: hotel.id,
        marketingFrequencyLimit: 3,
        frequencyWindowDays: 30,
        consentText: `I want to receive offers and discounts from ${hotel.name}.`,
        feedbackEnabled: true,
      },
      update: {},
    });

    // ---- Loyalty settings ---------------------------------------------------
    const loyaltySettings = await db.loyaltySettings.upsert({
      where: { hotelId: hotel.id },
      create: {
        hotelId: hotel.id,
        enabled: true,
        mode: "POINTS",
        pointsPer100: 10,
        pointsPerVisit: 50,
        pointsForReward: 500,
        rewardValue: 100,
        signupBonus: 50,
        silverTierSpend: 5000,
        goldTierSpend: 15000,
        vipTierSpend: 50000,
      },
      update: {},
    });
    void loyaltySettings;

    // ---- Message templates (9 defaults) -------------------------------------
    const templateCount = await db.messageTemplate.count({ where: { hotelId: hotel.id } });
    if (templateCount === 0) {
      await db.messageTemplate.createMany({
        data: DEFAULT_TEMPLATES.map((t) => ({
          hotelId: hotel.id,
          name: t.name,
          category: t.category,
          body: t.body,
          channels: t.channels,
          isDefault: true,
        })),
      });
    }

    // ---- QR codes ------------------------------------------------------------
    const qrCount = await db.qRCode.count({ where: { hotelId: hotel.id } });
    if (qrCount === 0) {
      await db.qRCode.createMany({
        data: [
          {
            hotelId: hotel.id,
            code: qrCode(),
            type: "LOYALTY",
            label: "Front Counter — Join Rewards",
            scans: 0,
            joins: 0,
          },
          {
            hotelId: hotel.id,
            code: qrCode(),
            type: "FEEDBACK",
            label: "Table QR — Feedback",
            scans: 0,
            joins: 0,
          },
          {
            hotelId: hotel.id,
            code: qrCode(),
            type: "MENU",
            label: "Menu / About us",
            scans: 0,
            joins: 0,
          },
        ],
      });
    }

    // ---- Loyalty accounts from restaurant visits ------------------------------
    const diners = await db.customer.findMany({
      where: { hotelId: hotel.id, totalRestaurantVisits: { gt: 0 } },
      include: { restaurantVisits: { orderBy: { visitDate: "asc" } } },
    });

    for (const c of diners) {
      const existing = await db.loyaltyAccount.findUnique({
        where: { hotelId_customerId: { hotelId: hotel.id, customerId: c.id } },
      });
      if (existing) continue;

      // Recompute points the same way the engine does (POINTS mode).
      let points = 0;
      for (const v of c.restaurantVisits) {
        points += Math.max(0, Math.floor(v.orderAmount / 100)) * loyaltySettings.pointsPer100;
      }
      // A few customers already redeemed their welcome bonus + reward.
      const redeemed = (c.id.charCodeAt(0) + c.id.charCodeAt(1)) % 3 === 0;
      const signupBonus = loyaltySettings.signupBonus;
      const redeemedPoints =
        redeemed && points + signupBonus > loyaltySettings.pointsForReward
          ? loyaltySettings.pointsForReward
          : 0;
      const balance = Math.max(0, points + signupBonus - redeemedPoints);

      const spend = c.totalRestaurantSpend;
      const tier =
        spend >= loyaltySettings.vipTierSpend
          ? "VIP"
          : spend >= loyaltySettings.goldTierSpend
            ? "GOLD"
            : spend >= loyaltySettings.silverTierSpend
              ? "SILVER"
              : "BRONZE";

      const account = await db.loyaltyAccount.create({
        data: {
          hotelId: hotel.id,
          customerId: c.id,
          points: balance,
          lifetimePoints: points + signupBonus,
          lifetimeSpend: spend,
          visitsCounted: c.restaurantVisits.length,
          tier,
        },
      });

      const txns: {
        hotelId: string;
        accountId: string;
        customerId: string;
        type: "SIGNUP_BONUS" | "EARN" | "REDEEM";
        points: number;
        reason: string;
        visitId?: string;
        balanceAfter: number;
        createdAt: Date;
      }[] = [];
      let running = 0;
      txns.push({
        hotelId: hotel.id,
        accountId: account.id,
        customerId: c.id,
        type: "SIGNUP_BONUS",
        points: signupBonus,
        reason: "Welcome bonus",
        balanceAfter: (running += signupBonus),
        createdAt: c.restaurantVisits[0] ? daysAgo(120) : daysAgo(30),
      });
      for (const v of c.restaurantVisits) {
        const pts = Math.max(0, Math.floor(v.orderAmount / 100)) * loyaltySettings.pointsPer100;
        txns.push({
          hotelId: hotel.id,
          accountId: account.id,
          customerId: c.id,
          type: "EARN",
          points: pts,
          reason: `Restaurant visit (₹${v.orderAmount.toFixed(2)})`,
          visitId: v.id,
          balanceAfter: (running += pts),
          createdAt: v.visitDate,
        });
      }
      if (redeemedPoints > 0) {
        txns.push({
          hotelId: hotel.id,
          accountId: account.id,
          customerId: c.id,
          type: "REDEEM",
          points: -redeemedPoints,
          reason: `Reward redeemed (₹${loyaltySettings.rewardValue.toFixed(2)})`,
          balanceAfter: (running -= redeemedPoints),
          createdAt: daysAgo(10),
        });
      }
      await db.loyaltyTransaction.createMany({ data: txns });
    }

    // ---- Feedback ----------------------------------------------------------------
    const feedbackCount = await db.feedback.count({ where: { hotelId: hotel.id } });
    if (feedbackCount === 0) {
      const someCustomers = await db.customer.findMany({
        where: { hotelId: hotel.id },
        take: 8,
        select: { id: true },
      });
      const samples = [
        {
          rating: 5,
          comment: "Butter chicken was outstanding, service even better!",
          days: 2,
          linked: true,
        },
        {
          rating: 4,
          comment: "Great ambience. Slightly slow on a Sunday evening.",
          days: 3,
          linked: true,
        },
        {
          rating: 5,
          comment: "Loved the new thali. Will come again with family.",
          days: 5,
          linked: true,
        },
        { rating: 3, comment: "Food was good but had to wait 20 minutes.", days: 7, linked: false },
        { rating: 5, comment: null, days: 9, linked: false },
        { rating: 2, comment: "Paneer was a bit cold when served.", days: 12, linked: false },
        { rating: 4, comment: "Nice place, my kids enjoyed the desserts.", days: 15, linked: true },
        { rating: 5, comment: "Best coffee in the neighbourhood ☕", days: 18, linked: false },
      ];
      await db.feedback.createMany({
        data: samples.map((s, i) => ({
          hotelId: hotel.id,
          customerId: s.linked && someCustomers[i] ? someCustomers[i].id : null,
          rating: s.rating,
          comment: s.comment,
          source: "QR_PAGE",
          createdAt: daysAgo(s.days),
        })),
      });
    }
  }

  const counts = {
    loyaltyAccounts: await db.loyaltyAccount.count(),
    loyaltyTxns: await db.loyaltyTransaction.count(),
    qrCodes: await db.qRCode.count(),
    templates: await db.messageTemplate.count(),
    feedback: await db.feedback.count(),
    hotelSettings: await db.hotelSettings.count(),
  };
  console.log("✓ Phase 6.3 seed complete:", counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

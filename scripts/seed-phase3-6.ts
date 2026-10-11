/**
 * Phase 3-6 seed script — adds automation rules, coupons, restaurant visits,
 * lead events, integrations, super admin + plans + tenant features.
 *
 * Run AFTER scripts/seed.ts:
 *   bun run scripts/seed.ts && bun run scripts/seed-phase3-6.ts
 *
 * Idempotent: safe to re-run.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "crypto";
import { ensurePlansSeed, ensureDefaultFeatureFlags, PLAN_DEFS } from "../src/lib/super-admin";

const db = new PrismaClient();

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function daysAgo(n: number, hour = 12): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d;
}

async function main() {
  console.log("→ Seeding plans...");
  await ensurePlansSeed();

  const hotels = await db.hotel.findMany({ include: { plan: true } });
  if (hotels.length === 0) {
    console.log("No hotels found. Run scripts/seed.ts first.");
    return;
  }

  // Attach STARTER plan to each hotel + create subscription + ensure features
  const starterPlan = await db.plan.findUnique({ where: { name: "PROFESSIONAL" } });
  if (!starterPlan) throw new Error("STARTER plan missing");

  for (const h of hotels) {
    await db.hotel.update({ where: { id: h.id }, data: { planId: starterPlan.id } });
    await db.subscription
      .upsert({
        where: { hotelId: h.id } as any,
        create: {
          hotelId: h.id,
          planId: starterPlan.id,
          status: "ACTIVE",
          amount: starterPlan.monthlyPrice,
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
        update: { planId: starterPlan.id, status: "ACTIVE", amount: starterPlan.monthlyPrice },
      } as any)
      .catch(() => null);
    // Subscription may not have unique hotelId — try upsert by hand
    const existing = await db.subscription.findFirst({ where: { hotelId: h.id } });
    if (!existing) {
      await db.subscription.create({
        data: {
          hotelId: h.id,
          planId: starterPlan.id,
          status: "ACTIVE",
          amount: starterPlan.monthlyPrice,
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
    }
    await ensureDefaultFeatureFlags(h.id);
  }

  const hotelA = hotels[0];
  console.log(`→ Seeding Phase 3-6 data for: ${hotelA.name}`);

  // 1. Coupons
  console.log("  • Coupons...");
  const couponDefs = [
    {
      code: "WELCOME10",
      description: "Welcome offer for first-time customers",
      discountType: "PERCENTAGE" as const,
      discountValue: 10,
      usageLimit: 100,
      customerLimit: 1,
    },
    {
      code: "RETURN15",
      description: "Return offer for past customers",
      discountType: "PERCENTAGE" as const,
      discountValue: 15,
      usageLimit: 200,
      customerLimit: 1,
    },
    {
      code: "VIP25",
      description: "VIP offer — high spenders only",
      discountType: "PERCENTAGE" as const,
      discountValue: 25,
      minimumOrder: 5000,
      usageLimit: 50,
      customerLimit: 1,
    },
    {
      code: "FLAT500",
      description: "₹500 off on orders ₹3,000+",
      discountType: "FIXED_AMOUNT" as const,
      discountValue: 500,
      minimumOrder: 3000,
      usageLimit: 100,
      customerLimit: 1,
    },
    {
      code: "BIRTHDAY-GIFT",
      description: "Birthday one-time offer",
      discountType: "ONE_TIME" as const,
      discountValue: 20,
      usageLimit: 1000,
      customerLimit: 1,
    },
  ];
  for (const c of couponDefs) {
    const existing = await db.coupon.findUnique({
      where: { hotelId_code: { hotelId: hotelA.id, code: c.code } },
    });
    if (!existing) {
      await db.coupon.create({
        data: {
          ...c,
          hotelId: hotelA.id,
          validFrom: new Date(),
          validUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
          active: true,
        },
      });
    }
  }

  // 2. Automations
  console.log("  • Automation rules...");
  const autoDefs = [
    {
      name: "3-Day Thank You",
      description: "Send a thank-you message 3 days after checkout",
      trigger: "HOTEL_CHECKOUT" as const,
      waitDays: 3,
      messageTemplate:
        "Hi {{name}}, thank you for staying with {{hotel_name}}! We hope you had a wonderful visit. 🙏",
    },
    {
      name: "Birthday Offer",
      description: "Send a birthday offer on the customer's birthday",
      trigger: "BIRTHDAY" as const,
      waitDays: 0,
      messageTemplate:
        "Happy birthday {{name}}! 🎉 Celebrate at {{hotel_name}} with {{offer}}. Book: {{booking_link}}",
    },
    {
      name: "30-Day Reactivation",
      description: "Re-engage customers inactive for 30 days",
      trigger: "INACTIVE_30" as const,
      waitDays: 0,
      messageTemplate:
        "Hi {{name}}, we miss you at {{hotel_name}}! Come back soon with {{offer}}: {{booking_link}}",
    },
    {
      name: "Restaurant Win-back",
      description: "Reach out 7 days after a restaurant visit",
      trigger: "RESTAURANT_VISIT" as const,
      waitDays: 7,
      messageTemplate:
        "Hi {{name}}, thanks for dining at {{hotel_name}}! We'd love to welcome you back. {{offer}} inside.",
    },
  ];
  for (const a of autoDefs) {
    const existing = await db.automationRule.findFirst({
      where: { hotelId: hotelA.id, name: a.name },
    });
    if (!existing) {
      await db.automationRule.create({
        data: {
          hotelId: hotelA.id,
          name: a.name,
          description: a.description,
          trigger: a.trigger,
          waitDays: a.waitDays,
          conditions: JSON.stringify([
            { kind: "marketing_consent", value: true },
            { kind: "no_opt_out" },
          ]),
          actions: JSON.stringify([
            { kind: "send_message", channels: ["WHATSAPP"], template: a.messageTemplate },
          ]),
          channels: JSON.stringify(["WHATSAPP"]),
          messageTemplate: a.messageTemplate,
          status: "ACTIVE",
        },
      });
    }
  }

  // 3. Restaurant visits for ~10 customers
  console.log("  • Restaurant visits...");
  const someCustomers = await db.customer.findMany({ where: { hotelId: hotelA.id }, take: 10 });
  const sources = ["WALK_IN", "RESERVATION", "ROOM_GUEST", "QR_MENU", "ONLINE_ORDER"] as const;
  const categories = ["VEG", "NON_VEG", "JAIN"] as const;
  const itemsPool = [
    "Paneer Tikka",
    "Butter Chicken",
    "Masala Dosa",
    "Veg Biryani",
    "Tandoori Roti",
    "Gulab Jamun",
    "Mutton Rogan Josh",
    "Palak Paneer",
    "Chole Bhature",
    "Fish Curry",
  ];
  for (const c of someCustomers) {
    const visitCount = 1 + Math.floor(Math.random() * 4);
    for (let i = 0; i < visitCount; i++) {
      const days = Math.floor(Math.random() * 60);
      const visitDate = daysAgo(days, 19 + Math.floor(Math.random() * 3));
      const orderAmount = 400 + Math.floor(Math.random() * 2000);
      const guests = 1 + Math.floor(Math.random() * 4);
      const source = sources[Math.floor(Math.random() * sources.length)];
      const category = categories[Math.floor(Math.random() * categories.length)];
      const items = Array.from(
        { length: 2 + Math.floor(Math.random() * 3) },
        () => itemsPool[Math.floor(Math.random() * itemsPool.length)],
      );
      const tableNum = `T-${1 + Math.floor(Math.random() * 20)}`;
      await db.restaurantVisit.create({
        data: {
          hotelId: hotelA.id,
          customerId: c.id,
          visitDate,
          tableNumber: tableNum,
          guests,
          orderAmount,
          foodCategory: category,
          favouriteItems: JSON.stringify(items),
          source,
        },
      });
      // Update customer's restaurant aggregates
      await db.customer.update({
        where: { id: c.id },
        data: {
          totalRestaurantVisits: { increment: 1 },
          totalRestaurantSpend: { increment: orderAmount },
          lastRestaurantVisit: visitDate,
          diningFrequency: { increment: 1 },
          favouriteCategory: category,
        },
      });
    }
  }

  // 4. Lead events for 5 customers
  console.log("  • Lead events...");
  const eventCustomers = await db.customer.findMany({ where: { hotelId: hotelA.id }, take: 5 });
  for (const c of eventCustomers) {
    const eventTypes = [
      { type: "MESSAGE_OPENED", points: 5 },
      { type: "LINK_CLICKED", points: 10 },
      { type: "OFFER_VIEWED", points: 10 },
      { type: "REPLIED", points: 20 },
    ];
    for (let i = 0; i < 3 + Math.floor(Math.random() * 4); i++) {
      const ev = eventTypes[Math.floor(Math.random() * eventTypes.length)];
      await db.leadEvent.create({
        data: {
          hotelId: hotelA.id,
          customerId: c.id,
          type: ev.type as any,
          points: ev.points,
          createdAt: daysAgo(Math.floor(Math.random() * 30), 12 + Math.floor(Math.random() * 10)),
        },
      });
      // Update customer.leadScore
      await db.customer.update({
        where: { id: c.id },
        data: { leadScore: { increment: ev.points } },
      });
    }
    // Update tier
    const refreshed = await db.customer.findUnique({
      where: { id: c.id },
      select: { leadScore: true },
    });
    if (refreshed) {
      const score = Math.min(100, refreshed.leadScore);
      const tier = score >= 81 ? "VERY_HOT" : score >= 61 ? "HOT" : score >= 31 ? "WARM" : "COLD";
      await db.customer.update({ where: { id: c.id }, data: { leadTier: tier } });
    }
  }

  // 5. Integrations
  console.log("  • Integrations...");
  const integrationDefs = [
    { type: "WHATSAPP_CLOUD", name: "WhatsApp Cloud — Grand Palace" },
    { type: "TWILIO_SMS", name: "Twilio SMS — Grand Palace" },
    { type: "STRIPE", name: "Stripe Payments" },
    { type: "RAZORPAY", name: "Razorpay Payments" },
  ];
  for (const i of integrationDefs) {
    const existing = await db.integration.findFirst({
      where: { hotelId: hotelA.id, type: i.type as any },
    });
    if (!existing) {
      await db.integration.create({
        data: {
          hotelId: hotelA.id,
          type: i.type as any,
          name: i.name,
          status:
            process.env.WHATSAPP_TOKEN && i.type === "WHATSAPP_CLOUD"
              ? "CONNECTED"
              : i.type === "WHATSAPP_CLOUD" || i.type === "TWILIO_SMS"
                ? "PENDING"
                : "DISCONNECTED",
          enabled: true,
        },
      });
    }
  }

  // 6. Notifications
  console.log("  • Notifications...");
  const notificationDefs: {
    level: "WARNING" | "INFO" | "CRITICAL";
    title: string;
    message: string;
  }[] = [
    {
      level: "WARNING",
      title: "WhatsApp integration not connected",
      message:
        "Connect WhatsApp Cloud API to enable real message delivery instead of simulation mode.",
    },
    {
      level: "INFO",
      title: "5 customers' birthdays this month",
      message:
        "Five of your customers have birthdays in the next 14 days. Consider running a Birthday campaign.",
    },
    {
      level: "CRITICAL",
      title: "🔥 2 customers promoted to Very Hot",
      message: "Two leads just crossed the Very Hot threshold — contact them now.",
    },
  ];
  for (const n of notificationDefs) {
    const existing = await db.notification.findFirst({
      where: { hotelId: hotelA.id, title: n.title },
    });
    if (!existing) {
      await db.notification.create({ data: { ...n, hotelId: hotelA.id } });
    }
  }

  // 7. A support session (history) — only when a Super Admin exists via bootstrap
  console.log("  • Support session (history)...");
  const superAdmin = await db.user.findFirst({ where: { role: "SUPER_ADMIN" } });
  if (superAdmin) {
    const existing = await db.supportSession.findFirst({ where: { hotelId: hotelA.id } });
    if (!existing) {
      await db.supportSession.create({
        data: {
          hotelId: hotelA.id,
          adminUserId: superAdmin.id,
          reason: "Initial onboarding check",
          durationMinutes: 30,
          startedAt: daysAgo(7, 14),
          expiresAt: daysAgo(7, 14),
          endedAt: daysAgo(7, 14),
          status: "ENDED",
        },
      });
    }
  }

  console.log("✓ Phase 3-6 seed complete.");
  console.log("");
  console.log(
    "Demo hotel logins (local development only — passwords were printed by scripts/seed.ts):",
  );
  console.log(
    "  Demo passwords are generated per-run and printed once. Check the seed output above.",
  );
  console.log("  Super Admin: run scripts/bootstrap-admin.ts (requires ADMIN_BOOTSTRAP_SECRET).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

/**
 * Seed script — StayLoop demo data.
 * Creates two hotels (to demonstrate multi-tenant isolation),
 * admins, staff, customers, and visits.
 *
 * Run: bun run scripts/seed.ts
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "crypto";

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
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed demo data in production.");
  }
  // Phase 2/3: no predictable demo passwords. Generate per-run random
  // passwords, print them ONCE (local dev only).
  // Test harness may pin the demo passwords via env (never in production).
  const demoPassword = (prefix: string) =>
    prefix + "-" + randomBytes(9).toString("base64url") + "7x";
  const adminPassword = process.env.STAYLOOP_SEED_ADMIN_PASSWORD || demoPassword("admin");
  const staffPassword = process.env.STAYLOOP_SEED_STAFF_PASSWORD || demoPassword("staff");

  console.log("Clearing existing data...");
  await db.auditLog.deleteMany();
  await db.visit.deleteMany();
  await db.customer.deleteMany();
  await db.user.deleteMany();
  await db.hotel.deleteMany();
  await db.authAttempt.deleteMany();

  console.log("Creating hotels + users...");
  const hotelA = await db.hotel.create({
    data: {
      name: "Grand Palace Hotel",
      location: "Jaipur, Rajasthan",
      phone: "+911412345678",
      email: "frontdesk@grandpalace.in",
    },
  });

  const hotelB = await db.hotel.create({
    data: {
      name: "Sea View Resort",
      location: "Calangute, Goa",
      phone: "+918322345678",
      email: "stay@seaview.in",
    },
  });

  await db.user.create({
    data: {
      hotelId: hotelA.id,
      name: "Arjun Mehta",
      email: "admin@grandpalace.com",
      passwordHash: hashPassword(adminPassword),
      role: "HOTEL_ADMIN",
    },
  });

  await db.user.create({
    data: {
      hotelId: hotelA.id,
      name: "Priya Nair",
      email: "staff@grandpalace.com",
      passwordHash: hashPassword(staffPassword),
      role: "HOTEL_STAFF",
    },
  });

  await db.user.create({
    data: {
      hotelId: hotelB.id,
      name: "Dinesh Rao",
      email: "admin@seaview.com",
      passwordHash: hashPassword(adminPassword),
      role: "HOTEL_ADMIN",
    },
  });

  console.log("Creating customers for Grand Palace Hotel...");
  const demoCustomers: {
    name: string;
    phone: string;
    email: string;
    consent: boolean;
    optOut?: boolean;
    vip?: boolean;
    roomPreference?: string;
    foodPreference?: string;
    location?: string;
    birthdayDays?: number; // days until next birthday (negative = passed this year)
    anniversaryDays?: number;
    source?: string;
    notes?: string;
    visits: { daysAgo: number; hours?: number; amount?: number; weekend?: boolean }[];
  }[] = [
    {
      name: "Rahul Sharma",
      phone: "+919876543210",
      email: "rahul.sharma@example.com",
      consent: true,
      roomPreference: "Deluxe King",
      foodPreference: "Non-veg",
      location: "Delhi",
      source: "BOOKING",
      notes: "Loves the rooftop restaurant. Travels with family.",
      visits: [
        { daysAgo: 45, amount: 8500 },
        { daysAgo: 30, amount: 9200 },
        { daysAgo: 9, amount: 11000 },
      ],
    },
    {
      name: "Ananya Iyer",
      phone: "+919812345678",
      email: "ananya.iyer@example.com",
      consent: true,
      roomPreference: "Garden View",
      location: "Bengaluru",
      source: "WEBSITE",
      birthdayDays: 9,
      visits: [
        { daysAgo: 60, amount: 6400 },
        { daysAgo: 12, amount: 7100 },
      ],
    },
    {
      name: "Vikram Singh Rathore",
      phone: "+919745612380",
      email: "vikram.rathore@example.com",
      consent: true,
      visits: [
        { daysAgo: 21, amount: 5200 },
        { daysAgo: 6, amount: 5800 },
      ],
    },
    {
      name: "Meera Kulkarni",
      phone: "+919632541270",
      email: "meera.k@example.com",
      consent: false,
      visits: [{ daysAgo: 15, amount: 4300 }],
    },
    {
      name: "Arnav Deshpande",
      phone: "+919598761230",
      email: "arnav.d@example.com",
      consent: true,
      vip: true,
      roomPreference: "Presidential Suite",
      foodPreference: "Jain",
      location: "Pune",
      source: "REFERRAL",
      notes: "Corporate account — books monthly. Champagne on arrival.",
      visits: [
        { daysAgo: 90, amount: 42000 },
        { daysAgo: 55, amount: 38000 },
        { daysAgo: 33, amount: 45000 },
        { daysAgo: 3, amount: 41000 },
      ],
    },
    {
      name: "Kavya Reddy",
      phone: "+919412365870",
      email: "kavya.reddy@example.com",
      consent: true,
      anniversaryDays: 10,
      visits: [
        { daysAgo: 18, amount: 9800 },
        { daysAgo: 2, amount: 10500 },
      ],
    },
    {
      name: "Rohan Malhotra",
      phone: "+919377712345",
      email: "rohan.m@example.com",
      consent: false,
      visits: [{ daysAgo: 8, amount: 3900 }],
    },
    {
      name: "Sneha Kapor",
      phone: "+919283847561",
      email: "sneha.kapor@example.com",
      consent: true,
      optOut: true,
      visits: [
        { daysAgo: 70, amount: 7200 },
        { daysAgo: 40, amount: 6900 },
      ],
    },
    {
      name: "Aditya Verma",
      phone: "+919182736455",
      email: "aditya.v@example.com",
      consent: true,
      visits: [
        { daysAgo: 25, amount: 6100 },
        { daysAgo: 1, amount: 6700 },
      ],
    },
    {
      name: "Ishita Bose",
      phone: "+919091827364",
      email: "ishita.bose@example.com",
      consent: false,
      visits: [],
    },
    {
      name: "Karan Johar",
      phone: "+919778866554",
      email: "karan.j@example.com",
      consent: true,
      roomPreference: "Executive Suite",
      location: "Mumbai",
      source: "WALK_IN",
      visits: [
        { daysAgo: 50, amount: 15400, weekend: true },
        { daysAgo: 11, amount: 16200, weekend: true },
      ],
    },
    {
      name: "Divya Menon",
      phone: "+919665544332",
      email: "divya.menon@example.com",
      consent: true,
      visits: [{ daysAgo: 5, amount: 5400 }],
    },
  ];

  for (const c of demoCustomers) {
    const birthday = c.birthdayDays !== undefined ? nextMonthlyDate(c.birthdayDays) : null;
    const customer = await db.customer.create({
      data: {
        hotelId: hotelA.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        marketingConsent: c.consent && !c.optOut,
        consentTimestamp: c.consent ? daysAgo(95, 10) : null,
        consentSource: c.consent ? (c.optOut ? "OPT_OUT" : "FRONT_DESK") : null,
        optOut: c.optOut ?? false,
        // Phase 6.4 — channel-level opt-ins for the demo dataset: consented
        // guests opted in to WhatsApp + SMS (email only where an address exists).
        whatsappOptIn: c.consent && !c.optOut,
        smsOptIn: c.consent && !c.optOut,
        emailOptIn: c.consent && !c.optOut && Boolean(c.email),
        vip: c.vip ?? false,
        roomPreference: c.roomPreference ?? null,
        foodPreference: c.foodPreference ?? null,
        location: c.location ?? null,
        birthday,
        anniversary: c.anniversaryDays !== undefined ? nextMonthlyDate(c.anniversaryDays) : null,
        source: c.source ?? null,
        notes: c.notes ?? null,
      },
    });

    for (const v of c.visits) {
      const checkin = daysAgo(v.daysAgo, v.hours ?? 14);
      if (v.weekend) {
        // shift checkin to the most recent past Saturday relative to daysAgo
        while (checkin.getDay() !== 6) checkin.setDate(checkin.getDate() - 1);
      }
      const checkout = new Date(checkin);
      checkout.setHours(checkout.getHours() + 24);
      await db.visit.create({
        data: {
          hotelId: hotelA.id,
          customerId: customer.id,
          checkin,
          checkout,
          source: "MANUAL",
          notes: null,
          amount: v.amount ?? null,
        },
      });
    }
  }

  console.log("Creating customers for Sea View Resort (isolation demo)...");
  const resortCustomer = await db.customer.create({
    data: {
      hotelId: hotelB.id,
      name: "Neha Pillai",
      phone: "+919876543210", // same phone as Rahul Sharma — different hotel, must be allowed
      email: "neha.pillai@example.com",
      marketingConsent: true,
      consentTimestamp: daysAgo(30, 10),
      consentSource: "FRONT_DESK",
    },
  });
  await db.visit.create({
    data: {
      hotelId: hotelB.id,
      customerId: resortCustomer.id,
      checkin: daysAgo(10, 15),
      checkout: daysAgo(9, 11),
      source: "MANUAL",
    },
  });

  console.log("Seeding audit log entries...");
  const adminA = await db.user.findUnique({ where: { email: "admin@grandpalace.com" } });
  await db.auditLog.create({
    data: {
      hotelId: hotelA.id,
      userId: adminA!.id,
      action: "HOTEL_CREATED",
      entityType: "hotel",
      entityId: hotelA.id,
      metadata: JSON.stringify({ hotelName: hotelA.name }),
    },
  });

  const counts = {
    hotels: await db.hotel.count(),
    users: await db.user.count(),
    customers: await db.customer.count(),
    visits: await db.visit.count(),
  };
  console.log("Seed complete:", counts);
  console.log("");
  console.log("Demo logins (local development ONLY — random per run, never committed):");
  console.log(`  Grand Palace Hotel  →  admin@grandpalace.com / ${adminPassword}  (HOTEL_ADMIN)`);
  console.log(`                         staff@grandpalace.com / ${staffPassword}   (HOTEL_STAFF)`);
  console.log(`  Sea View Resort     →  admin@seaview.com / ${adminPassword}      (HOTEL_ADMIN)`);
  console.log("");
  console.log(
    "Super Admin: bun run scripts/bootstrap-admin.ts --name 'Platform Admin' --email <email>",
  );
  console.log("             (requires ADMIN_BOOTSTRAP_SECRET in the environment)");
}

/** A date n days from today (for birthdays/anniversaries within the look-ahead). */
function nextMonthlyDate(daysFromNow: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(0, 0, 0, 0);
  return d;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

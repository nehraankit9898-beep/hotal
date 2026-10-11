/**
 * E2E DEMO SEED — Phase 12/13 restaurant demo data (synthetic only).
 * Run against the dev demo DB: bun run scripts/seed-demo-restaurant.ts
 */
import { db } from "../src/lib/db";
import { randomBytes } from "crypto";

async function main() {
  const hotel = await db.hotel.findFirst({ where: { name: "Grand Palace Hotel" } });
  if (!hotel) throw new Error("Grand Palace Hotel not found — run scripts/seed.ts first");

  // Clear previous demo restaurant data (idempotent re-runs)
  await db.orderEvent.deleteMany({ where: { hotelId: hotel.id } });
  await db.orderItem.deleteMany({ where: { order: { hotelId: hotel.id } } });
  await db.diningOrder.deleteMany({ where: { hotelId: hotel.id } });
  await db.tableSession.deleteMany({ where: { hotelId: hotel.id } });
  await db.qRCode.deleteMany({ where: { hotelId: hotel.id, tableId: { not: null } } });
  await db.diningTable.deleteMany({ where: { hotelId: hotel.id } });
  await db.menuItem.deleteMany({ where: { hotelId: hotel.id } });
  await db.menuCategory.deleteMany({ where: { hotelId: hotel.id } });

  // Rename hotel to a restaurant for the demo
  await db.hotel.update({
    where: { id: hotel.id },
    data: { name: "Spice Route Restaurant", city: "Mumbai", location: "Bandra West, Mumbai" },
  });

  const cat = {
    starters: await db.menuCategory.create({
      data: { hotelId: hotel.id, name: "Starters", description: "Small plates to share", sortOrder: 0 },
    }),
    mains: await db.menuCategory.create({
      data: { hotelId: hotel.id, name: "Main Course", description: "From the tandoor & kadhai", sortOrder: 1 },
    }),
    breads: await db.menuCategory.create({
      data: { hotelId: hotel.id, name: "Breads & Rice", sortOrder: 2 },
    }),
    drinks: await db.menuCategory.create({
      data: { hotelId: hotel.id, name: "Beverages", sortOrder: 3 },
    }),
  };

  const paneer = await db.menuItem.create({
    data: {
      hotelId: hotel.id,
      categoryId: cat.starters.id,
      name: "Paneer Tikka",
      description: "Char-grilled cottage cheese, mint chutney",
      priceMinor: 28000,
      prepMinutes: 15,
      dietaryTags: '["VEG","SPICY"]',
      sortOrder: 0,
    },
  });
  await db.menuItem.create({
    data: {
      hotelId: hotel.id,
      categoryId: cat.starters.id,
      name: "Crispy Chilli Potato",
      description: "Honey-chilli tossed fries",
      priceMinor: 22000,
      prepMinutes: 10,
      dietaryTags: '["VEG","SPICY"]',
      sortOrder: 1,
    },
  });
  await db.menuItem.create({
    data: {
      hotelId: hotel.id,
      categoryId: cat.starters.id,
      name: "Chicken 65",
      description: "South-Indian fried chicken, curry leaf",
      priceMinor: 32000,
      prepMinutes: 18,
      dietaryTags: '["NON_VEG","SPICY"]',
      sortOrder: 2,
    },
  });

  const butterChicken = await db.menuItem.create({
    data: {
      hotelId: hotel.id,
      categoryId: cat.mains.id,
      name: "Butter Chicken",
      description: "Slow-cooked, cashew-tomato gravy",
      priceMinor: 42000,
      prepMinutes: 22,
      dietaryTags: '["NON_VEG"]',
      sortOrder: 0,
    },
  });
  const dal = await db.menuItem.create({
    data: {
      hotelId: hotel.id,
      categoryId: cat.mains.id,
      name: "Dal Makhani",
      description: "Overnight-simmered black lentils",
      priceMinor: 30000,
      prepMinutes: 15,
      dietaryTags: '["VEG"]',
      sortOrder: 1,
    },
  });
  // Thali with an option group
  const thali = await db.menuItem.create({
    data: {
      hotelId: hotel.id,
      categoryId: cat.mains.id,
      name: "Royal Thali",
      description: "Complete meal: curries, breads, dessert",
      priceMinor: 45000,
      prepMinutes: 25,
      dietaryTags: '["VEG"]',
      sortOrder: 2,
      optionGroups: {
        create: {
          hotelId: hotel.id,
          name: "Bread choice",
          required: true,
          minSelect: 1,
          maxSelect: 1,
          sortOrder: 0,
          options: {
            create: [
              { hotelId: hotel.id, name: "Tandoori Roti (3)", priceDeltaMinor: 0, sortOrder: 0 },
              { hotelId: hotel.id, name: "Butter Naan (3)", priceDeltaMinor: 5000, sortOrder: 1 },
            ],
          },
        },
      },
    },
  });

  await db.menuItem.create({
    data: {
      hotelId: hotel.id,
      categoryId: cat.breads.id,
      name: "Garlic Naan",
      priceMinor: 9000,
      prepMinutes: 8,
      dietaryTags: '["VEG"]',
      sortOrder: 0,
    },
  });
  await db.menuItem.create({
    data: {
      hotelId: hotel.id,
      categoryId: cat.drinks.id,
      name: "Masala Chai",
      priceMinor: 8000,
      prepMinutes: 6,
      dietaryTags: '["VEG"]',
      sortOrder: 0,
    },
  });
  const lassi = await db.menuItem.create({
    data: {
      hotelId: hotel.id,
      categoryId: cat.drinks.id,
      name: "Sweet Lassi",
      priceMinor: 14000,
      prepMinutes: 5,
      dietaryTags: '["VEG"]',
      sortOrder: 1,
    },
  });

  // Tables with bound ORDER QR codes
  const tables = [
    { number: "T1", capacity: 2, zone: "Window" },
    { number: "T2", capacity: 4, zone: "Main hall" },
    { number: "T3", capacity: 6, zone: "Main hall" },
    { number: "G1", capacity: 4, zone: "Garden" },
  ];
  const qrs: { number: string; code: string }[] = [];
  for (const t of tables) {
    const code = randomBytes(24).toString("base64url");
    await db.diningTable.create({
      data: {
        hotelId: hotel.id,
        number: t.number,
        capacity: t.capacity,
        zone: t.zone,
        qrCodes: {
          create: { hotelId: hotel.id, code, type: "ORDER", label: `Table ${t.number}` },
        },
      },
    });
    qrs.push({ number: t.number, code });
  }

  console.log("Demo restaurant data seeded for", hotel.name);
  console.log("Items:", paneer.name, butterChicken.name, dal.name, thali.name, lassi.name);
  console.log("Tables + QR:", JSON.stringify(qrs, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

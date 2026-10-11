/**
 * Phase 14/15/16 demo seed — adds tax rule + POS-ready data to the demo
 * tenant (Grand Palace) so the UI flows can be exercised end to end.
 * Idempotent: reuses existing rows where possible.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

const db = new PrismaClient();

async function main() {
  // Target the hotel that owns the Phase 12/13 demo menu (Spice Route) or
  // fall back to the first hotel with menu items.
  let hotel = await db.hotel.findFirst({ where: { name: { contains: "Spice Route" } } });
  if (!hotel) {
    hotel = await db.hotel.findFirst({
      where: { menuItems: { some: {} } },
    });
  }
  if (!hotel) throw new Error("No hotel with a demo menu found — run scripts/seed-demo-restaurant.ts first.");
  const hotelId = hotel.id;

  // 1. GST tax rule (idempotent by name)
  const existingRule = await db.taxRule.findFirst({ where: { hotelId, name: "GST 5% — dine-in (incl.)" } });
  if (!existingRule) {
    await db.taxRule.create({
      data: {
        hotelId,
        name: "GST 5% — dine-in (incl.)",
        type: "CGST_SGST",
        rateBps: 500,
        isInclusive: true,
        scopeType: "ALL",
        effectiveFrom: new Date(),
      },
    });
    console.log("tax rule created");
  }

  // 2. Demo table with QR (reuse if present)
  let table = await db.diningTable.findFirst({ where: { hotelId, number: "T-POS-1" } });
  if (!table) {
    table = await db.diningTable.create({ data: { hotelId, number: "T-POS-1", capacity: 4, zone: "Main Hall" } });
    await db.qRCode.create({
      data: { hotelId, code: randomBytes(24).toString("base64url"), type: "ORDER", tableId: table.id, label: "POS demo table" },
    });
  }
  console.log("table:", table.number);

  // 3. Open a session with an order (if the table has no open session)
  const open = await db.tableSession.findFirst({ where: { hotelId, tableId: table.id, status: "OPEN" } });
  if (!open) {
    const session = await db.tableSession.create({
      data: {
        hotelId,
        tableId: table.id,
        guestName: "Demo Guest",
        publicToken: randomBytes(24).toString("base64url"),
        openFence: 1,
      },
    });
    const item = await db.menuItem.findFirst({ where: { hotelId, active: true, available: true } });
    if (item) {
      const seq = await db.diningOrder.count({ where: { hotelId } });
      await db.diningOrder.create({
        data: {
          hotelId,
          tableSessionId: session.id,
          tableId: table.id,
          orderNumber: seq + 1,
          status: "SERVED",
          source: "STAFF",
          subtotalMinor: item.priceMinor * 2,
          totalMinor: item.priceMinor * 2,
          currency: "INR",
          customerName: "Demo Diner",
          publicToken: randomBytes(24).toString("base64url"),
          items: {
            create: {
              menuItemId: item.id,
              nameSnapshot: item.name,
              unitPriceMinor: item.priceMinor,
              quantity: 2,
              lineTotalMinor: item.priceMinor * 2,
              status: "SERVED",
            },
          },
          events: {
            create: { hotelId, type: "ORDER_SERVED", actorType: "STAFF", metadata: "{}" },
          },
        },
      });
    }
    console.log("session + served order created");
  } else {
    console.log("open session already present");
  }

  // 4. Promotion demo
  const promo = await db.promotion.findFirst({ where: { hotelId, name: "Evening Happy Hour 10%" } });
  if (!promo) {
    await db.promotion.create({
      data: {
        hotelId,
        name: "Evening Happy Hour 10%",
        type: "PERCENT",
        percentBps: 1000,
        daysOfWeek: JSON.stringify(["MON", "TUE", "WED", "THU", "FRI"]),
        startTime: "18:00",
        endTime: "20:00",
      },
    });
    console.log("promotion created");
  }

  // 5. Ingredients + recipe on one item
  const ing = await db.ingredient.findFirst({ where: { hotelId, name: "Paneer (demo)" } });
  const item = await db.menuItem.findFirst({ where: { hotelId, active: true } });
  if (!ing && item) {
    const created = await db.ingredient.create({
      data: { hotelId, name: "Paneer (demo)", unit: "GRAM", costPerUnitMinor: 40, lowStockThreshold: 500 },
    });
    await db.stockLedger.create({
      data: { hotelId, ingredientId: created.id, reason: "OPENING", qtyDelta: 8000, balanceAfter: 8000, note: "Demo opening stock" },
    });
    await db.ingredient.update({ where: { id: created.id }, data: { stockQty: 8000 } });
    await db.recipeLine.create({
      data: { hotelId, menuItemId: item.id, ingredientId: created.id, qtyPerUnit: 150 },
    });
    console.log("ingredient + recipe created");
  }

  // 6. Reservation demo (future date, no conflicts)
  const future = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const resv = await db.reservation.findFirst({ where: { hotelId, date: future, startTime: "20:00" } });
  if (!resv) {
    await db.reservation.create({
      data: {
        hotelId,
        tableId: table.id,
        date: future,
        startTime: "20:00",
        durationMinutes: 90,
        partySize: 3,
        guestName: "Demo Reservation",
        guestPhone: "9876543210",
        status: "CONFIRMED",
        source: "STAFF",
      },
    });
    console.log("reservation created for", future);
  }

  console.log("DEMO SEED DONE");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

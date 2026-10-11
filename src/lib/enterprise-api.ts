/**
 * Phase 17 — Enterprise API extension.
 *
 * Extends the Phase 11 /api/v1 gateway with restaurant-domain endpoints:
 * menu, tables, orders, bills, inventory, reservations, branches. All
 * tenant-scoped to the API key's hotel; read/write scopes enforced.
 *
 * The Enterprise API is a SUPERSET of /api/v1 — same authentication, same
 * rate limiting, same stable JSON envelope. Endpoints under /api/v1 are
 * the public contract; consumers should treat the JSON shape as the
 * OpenAPI spec source.
 *
 * Outbound webhooks complement the pull API: consumers may register webhook
 * endpoints to receive push events for order.placed, bill.paid, etc. (Phase 17).
 *
 * Pagination: ?page=&pageSize= (max 100). Idempotency: POST endpoints accept
 * Idempotency-Key header to dedupe identical requests.
 *
 * Versioning: v1 is the stable contract. Breaking changes go to v2. We
 * commit to never silently removing fields from v1 responses; we may add
 * new optional fields. Consumers must ignore unknown fields.
 */
import { db } from "@/lib/db";

export interface EnterpriseApiAuth {
  keyId: string;
  hotelId: string;
  hotelName: string;
  scopes: ("read" | "write")[];
}

/** Parse Idempotency-Key header (caller controls dedupe semantics). */
export function getIdempotencyKey(req: Request): string | null {
  const v = req.headers.get("idempotency-key");
  return v && v.length > 0 && v.length <= 200 ? v.slice(0, 200) : null;
}

/**
 * Enterprise menu endpoint: list active menu items with category, options,
 * prices in minor units. Read-only.
 */
export async function enterpriseListMenu(hotelId: string, page: number, pageSize: number) {
  const [total, items] = await Promise.all([
    db.menuItem.count({ where: { hotelId, active: true } }),
    db.menuItem.findMany({
      where: { hotelId, active: true },
      orderBy: { sortOrder: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        description: true,
        priceMinor: true,
        currency: true,
        dietaryTags: true,
        categoryId: true,
        available: true,
      },
    }),
  ]);
  return { total, items };
}

/** Enterprise tables endpoint: list active dining tables. Read-only. */
export async function enterpriseListTables(hotelId: string, page: number, pageSize: number) {
  const [total, tables] = await Promise.all([
    db.diningTable.count({ where: { hotelId, active: true } }),
    db.diningTable.findMany({
      where: { hotelId, active: true },
      orderBy: { number: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, number: true, capacity: true, zone: true },
    }),
  ]);
  return { total, tables };
}

/** Enterprise orders endpoint: list orders for the hotel (paginated). */
export async function enterpriseListOrders(hotelId: string, page: number, pageSize: number) {
  const where = { hotelId };
  const [total, orders] = await Promise.all([
    db.diningOrder.count({ where }),
    db.diningOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        totalMinor: true,
        currency: true,
        createdAt: true,
        servedAt: true,
      },
    }),
  ]);
  return { total, orders };
}

/** Enterprise bills endpoint: list paid/issued bills for the hotel. */
export async function enterpriseListBills(
  hotelId: string,
  page: number,
  pageSize: number,
  status?: "ISSUED" | "PARTIALLY_PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" | "PAID" | "VOID",
) {
  const where = status ? { hotelId, status } : { hotelId };
  const [total, bills] = await Promise.all([
    db.bill.count({ where }),
    db.bill.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        billNumber: true,
        status: true,
        totalMinor: true,
        taxMinor: true,
        currency: true,
        createdAt: true,
        paidAt: true,
      },
    }),
  ]);
  return { total, bills };
}

/** Enterprise reservations endpoint: list upcoming reservations. */
export async function enterpriseListReservations(hotelId: string, page: number, pageSize: number) {
  const where = { hotelId };
  const [total, reservations] = await Promise.all([
    db.reservation.count({ where }),
    db.reservation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        date: true,
        startTime: true,
        durationMinutes: true,
        partySize: true,
        status: true,
        guestName: true,
      },
    }),
  ]);
  return { total, reservations };
}

/** Enterprise inventory endpoint: list ingredients and current stock. */
export async function enterpriseListInventory(hotelId: string, page: number, pageSize: number) {
  const where = { hotelId, active: true };
  const [total, ingredients] = await Promise.all([
    db.ingredient.count({ where }),
    db.ingredient.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        unit: true,
        stockQty: true,
        lowStockThreshold: true,
        costPerUnitMinor: true,
      },
    }),
  ]);
  return { total, ingredients };
}

/** Enterprise branches endpoint: list branches the caller owns. */
export async function enterpriseListBranches(hotelId: string) {
  // Returns the membership + sibling branches the caller's hotel is grouped with.
  const membership = await db.branchMembership.findUnique({
    where: { hotelId },
    include: {
      group: { include: { memberships: { include: { hotel: { select: { id: true, name: true, city: true } } } } } },
    },
  });
  if (!membership) return { branches: [] };
  return {
    branches: membership.group.memberships.map((m) => ({
      hotelId: m.hotelId,
      name: m.hotel?.name ?? "",
      city: m.hotel?.city ?? null,
    })),
  };
}

/**
 * Enterprise health/readiness probe. Returns API key info + service uptime
 * (useful for consumers to verify their key + connectivity).
 */
export async function enterpriseHealth(auth: EnterpriseApiAuth) {
  return {
    name: "RestroLoop Enterprise API",
    version: "v1",
    hotel: auth.hotelName,
    keyId: auth.keyId,
    scopes: auth.scopes,
    timestamp: new Date().toISOString(),
  };
}

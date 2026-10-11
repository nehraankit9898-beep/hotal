/**
 * Phase 13 — Ordering, table sessions & KDS service.
 *
 * Core guarantees:
 *  - PRICING IS SERVER-COMPUTED. The customer cart sends item ids + option
 *    ids + quantities ONLY; prices come from the current valid catalog and
 *    line snapshots (name, unit price, options) are frozen onto the order.
 *  - IDEMPOTENT SUBMIT. The client generates a UUID idempotency key; a retry
 *    (network timeout → user taps again) with the same key returns the SAME
 *    order. The DB unique constraint on idempotencyKey is the fence.
 *  - STATE MACHINE. PLACED → PREPARING → READY → SERVED, with CANCELLED as a
 *    terminal side-state. Transitions are validated + applied with status
 *    re-checks inside one updateMany (optimistic concurrency — two staff
 *    racing cannot produce impossible states).
 *  - PUBLIC TOKENS are 32-char random url-safe strings — guess-resistant by
 *    construction (same entropy as QR identifiers). The token exposes ONLY
 *    its own order's status, never other tables or customer data.
 *  - ORDER EVENTS. Every transition appends an immutable OrderEvent row —
 *    the durable history future POS/loyalty phases consume (no catch-and-
 *    forget).
 */

import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import type { OrderEventType as OrderEventTypeName } from "@prisma/client";

export type DiningOrderStatus = "PLACED" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";
export type OrderItemStatus = "PENDING" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";

/** Legal order-level transitions (documented state diagram). */
const ORDER_TRANSITIONS: Record<DiningOrderStatus, DiningOrderStatus[]> = {
  PLACED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["SERVED", "CANCELLED"],
  SERVED: [],
  CANCELLED: [],
};

/** Legal item-level transitions. */
const ITEM_TRANSITIONS: Record<OrderItemStatus, OrderItemStatus[]> = {
  PENDING: ["PREPARING", "READY", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["SERVED", "CANCELLED"],
  SERVED: [],
  CANCELLED: [],
};

export function canTransition(
  from: DiningOrderStatus | OrderItemStatus,
  to: DiningOrderStatus | OrderItemStatus,
): boolean {
  const table = ORDER_TRANSITIONS[from as DiningOrderStatus] ?? ITEM_TRANSITIONS[from as OrderItemStatus];
  return Array.isArray(table) && table.includes(to as never);
}

export function newPublicToken(): string {
  return randomBytes(24).toString("base64url"); // 32 chars, url-safe, 192 bits
}

/* ------------------------------------------------------------------ */
/* Event mapping (typed — no `as never` casts; BUG-1)                  */
/* ------------------------------------------------------------------ */

/**
 * Explicit order-level status → OrderEventType map. BUG-1 root cause was a
 * string-concatenated enum value ("ORDER_" + to) hidden from TypeScript by
 * an `as never` cast, producing "ORDER_PREPARING" — a value that did not
 * exist in OrderEventType. Each map is checked with `satisfies` against the
 * GENERATED Prisma enum union, so a missing member is a COMPILE error — the
 * exact class of bug the `as never` casts used to hide.
 */
const ORDER_EVENT_BY_STATUS = {
  PLACED: "ORDER_PLACED",
  PREPARING: "ORDER_PREPARING", // enum member added in both schemas + migration 0006
  READY: "ORDER_READY",
  SERVED: "ORDER_SERVED",
  CANCELLED: "ORDER_CANCELLED",
} as const satisfies Record<DiningOrderStatus, OrderEventTypeName>;

const ITEM_EVENT_BY_STATUS = {
  PENDING: "ITEM_PREPARING", // never written (no transitions INTO PENDING)
  PREPARING: "ITEM_PREPARING",
  READY: "ITEM_READY",
  SERVED: "ITEM_SERVED",
  CANCELLED: "ITEM_CANCELLED", // distinct item-level cancel event (BUG-1 family)
} as const satisfies Record<OrderItemStatus, OrderEventTypeName>;

/* ------------------------------------------------------------------ */
/* Cart pricing (server-side, from the CURRENT valid catalog)          */
/* ------------------------------------------------------------------ */

export interface CartLineInput {
  menuItemId: string;
  quantity: number;
  optionIds?: string[]; // MenuOption ids across the item's groups
  notes?: string;
}

export interface PricedLine {
  menuItemId: string;
  nameSnapshot: string;
  unitPriceMinor: number;
  quantity: number;
  optionsSnapshot: string; // JSON
  lineTotalMinor: number;
  notes: string | null;
}

export interface PricedCart {
  lines: PricedLine[];
  subtotalMinor: number;
  currency: string;
}

export class CartValidationError extends Error {
  constructor(
    message: string,
    public code:
      | "EMPTY_CART"
      | "ITEM_NOT_FOUND"
      | "ITEM_UNAVAILABLE"
      | "OPTION_INVALID"
      | "OPTION_REQUIRED"
      | "OPTION_LIMIT"
      | "QUANTITY_INVALID"
      | "SESSION_CLOSED",
  ) {
    super(message);
  }
}

/**
 * Price a customer/staff cart against the CURRENT catalog. Throws
 * CartValidationError on any mismatch — the client total is never consulted.
 */
export async function priceCart(
  hotelId: string,
  cart: CartLineInput[],
): Promise<PricedCart> {
  if (!Array.isArray(cart) || cart.length === 0) {
    throw new CartValidationError("Your cart is empty.", "EMPTY_CART");
  }
  if (cart.length > 50) {
    throw new CartValidationError("Too many distinct items in one order (max 50).", "QUANTITY_INVALID");
  }

  let currency = "INR";
  const lines: PricedLine[] = [];
  let subtotalMinor = 0;

  for (const line of cart) {
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      throw new CartValidationError("Quantity must be between 1 and 50.", "QUANTITY_INVALID");
    }

    const item = await db.menuItem.findFirst({
      where: { id: line.menuItemId, hotelId, active: true },
      include: {
        // D07: the item's CATEGORY must also be active — an archived category
        // must not keep selling through already-loaded clients.
        category: { select: { active: true } },
        optionGroups: {
          where: { active: true },
          include: { options: { where: { active: true } } },
        },
      },
    });
    if (!item) {
      throw new CartValidationError("One of the items is no longer on the menu.", "ITEM_NOT_FOUND");
    }
    if (!item.available) {
      throw new CartValidationError(`${item.name} is currently sold out.`, "ITEM_UNAVAILABLE");
    }
    if (!item.category?.active) {
      throw new CartValidationError(
        `${item.name} is no longer being offered.`,
        "ITEM_UNAVAILABLE",
      );
    }
    currency = item.currency;

    // ---- Option validation against the SERVER's group constraints ----
    const selectedIds = (line.optionIds ?? []).filter((id) => typeof id === "string");
    const selected: {
      groupId: string;
      groupName: string;
      optionId: string;
      optionName: string;
      priceDeltaMinor: number;
    }[] = [];

    for (const group of item.optionGroups) {
      const inGroup = group.options.filter((o) => selectedIds.includes(o.id));
      if (group.required && inGroup.length < Math.max(1, group.minSelect)) {
        throw new CartValidationError(
          `Please choose an option for "${group.name}".`,
          "OPTION_REQUIRED",
        );
      }
      if (inGroup.length < group.minSelect) {
        throw new CartValidationError(
          `"${group.name}" needs at least ${group.minSelect} choices.`,
          "OPTION_LIMIT",
        );
      }
      if (inGroup.length > group.maxSelect) {
        throw new CartValidationError(
          `"${group.name}" allows at most ${group.maxSelect} choices.`,
          "OPTION_LIMIT",
        );
      }
      for (const opt of inGroup) {
        selected.push({
          groupId: group.id,
          groupName: group.name,
          optionId: opt.id,
          optionName: opt.name,
          priceDeltaMinor: opt.priceDeltaMinor,
        });
      }
    }

    // Any selected option that did not belong to one of the item's groups →
    // reject (never accept cross-item option smuggling).
    const knownIds = new Set(item.optionGroups.flatMap((g) => g.options.map((o) => o.id)));
    for (const id of selectedIds) {
      if (!knownIds.has(id)) {
        throw new CartValidationError("Invalid option selection.", "OPTION_INVALID");
      }
    }

    const unitPriceMinor = item.priceMinor + selected.reduce((s, o) => s + o.priceDeltaMinor, 0);
    const lineTotalMinor = unitPriceMinor * quantity;
    subtotalMinor += lineTotalMinor;

    lines.push({
      menuItemId: item.id,
      nameSnapshot: item.name,
      unitPriceMinor,
      quantity,
      optionsSnapshot: JSON.stringify(selected),
      lineTotalMinor,
      notes: typeof line.notes === "string" && line.notes.trim() ? line.notes.trim().slice(0, 300) : null,
    });
  }

  return { lines, subtotalMinor, currency };
}

/* ------------------------------------------------------------------ */
/* Order creation (idempotent)                                         */
/* ------------------------------------------------------------------ */

export interface CreateOrderInput {
  hotelId: string;
  cart: CartLineInput[];
  idempotencyKey?: string;
  tableSessionId?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  notes?: string | null;
  placedByUserId?: string | null;
  source: "QR_CUSTOMER" | "STAFF";
}

export interface CreateOrderResult {
  created: boolean; // false → idempotent replay of an existing order
  order: {
    id: string;
    orderNumber: number;
    publicToken: string;
    status: DiningOrderStatus;
    subtotalMinor: number;
    totalMinor: number;
    currency: string;
    placedAt: string;
  };
}

/**
 * Create an order with server-computed pricing and idempotency. When the
 * idempotencyKey was already used, the EXISTING order is returned (created:
 * false) — a network retry must never place a duplicate order.
 *
 * Concurrency contract (BUG-8/D06):
 *  - The idempotent replay lookup is TENANT-SCOPED: a replayed key only
 *    matches an order belonging to the SAME hotel (defense-in-depth on top
 *    of the route-level key prefixes).
 *  - N simultaneous submissions with one key: exactly one create wins; the
 *    losers catch the unique-constraint (P2002) violation and REPLAY the
 *    winner's order — concurrent retries get [201, 200, 200, 200], never
 *    [201, 500, 500, 500].
 *  - orderNumber allocation retries on a (hotelId, orderNumber) unique
 *    collision instead of surfacing a 500.
 */
export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  // Idempotent replay path: check BEFORE pricing so a retry after a catalog
  // change still returns the original order, not a validation error.
  if (input.idempotencyKey) {
    const existing = await db.diningOrder.findFirst({
      where: { idempotencyKey: input.idempotencyKey, hotelId: input.hotelId },
    });
    if (existing) {
      return {
        created: false,
        order: orderSummary(existing),
      };
    }
  }

  const priced = await priceCart(input.hotelId, input.cart);

  // Resolve + validate the table session (if any) BEFORE the transaction.
  let tableId: string | null = null;
  if (input.tableSessionId) {
    const session = await db.tableSession.findFirst({
      where: { id: input.tableSessionId, hotelId: input.hotelId, status: "OPEN" },
      select: { id: true, tableId: true, table: { select: { active: true } } },
    });
    // D07: an archived table must not keep accepting orders from an
    // already-issued (still OPEN) session.
    if (!session || !session.table.active) {
      throw new CartValidationError(
        "This table session is no longer active. Please scan the table QR again.",
        "SESSION_CLOSED",
      );
    }
    tableId = session.tableId;
  }

  // D07: execution-time tenant eligibility — a suspended tenant must not
  // accept orders from clients that already hold an open session.
  const hotelStatus = await db.hotel.findUnique({
    where: { id: input.hotelId },
    select: { status: true },
  });
  if (!hotelStatus || hotelStatus.status !== "ACTIVE") {
    throw new CartValidationError(
      "Online ordering is currently unavailable. Please ask our staff.",
      "SESSION_CLOSED",
    );
  }

  const notes =
    typeof input.notes === "string" && input.notes.trim()
      ? input.notes.trim().slice(0, 500)
      : null;

  const createOnce = async (): Promise<CreateOrderResult> => {
    const order = await db.$transaction(async (tx) => {
      // Per-tenant sequential order number. Allocation is retried on a
      // unique collision (two concurrent creates can read the same max).
      let orderNumber = 1;
      const last = await tx.diningOrder.findFirst({
        where: { hotelId: input.hotelId },
        orderBy: { orderNumber: "desc" },
        select: { orderNumber: true },
      });
      if (last) orderNumber = last.orderNumber + 1;

      return tx.diningOrder.create({
        data: {
          hotelId: input.hotelId,
          tableSessionId: input.tableSessionId ?? null,
          tableId,
          orderNumber,
          status: "PLACED",
          source: input.source,
          subtotalMinor: priced.subtotalMinor,
          totalMinor: priced.subtotalMinor, // tax contract reserved for Phase 14
          currency: priced.currency,
          notes,
          customerName: input.customerName?.slice(0, 120) ?? null,
          customerPhone: input.customerPhone?.slice(0, 20) ?? null,
          publicToken: newPublicToken(),
          idempotencyKey: input.idempotencyKey ?? null,
          placedByUserId: input.placedByUserId ?? null,
          items: {
            create: priced.lines.map((line) => ({
              menuItemId: line.menuItemId,
              nameSnapshot: line.nameSnapshot,
              unitPriceMinor: line.unitPriceMinor,
              quantity: line.quantity,
              optionsSnapshot: line.optionsSnapshot,
              lineTotalMinor: line.lineTotalMinor,
              notes: line.notes,
              status: "PENDING" as const,
            })),
          },
          events: {
            create: {
              hotelId: input.hotelId,
              type: "ORDER_PLACED",
              actorType: input.source === "STAFF" ? "STAFF" : "CUSTOMER",
              actorId: input.placedByUserId ?? null,
              actorName: input.customerName ?? null,
              metadata: JSON.stringify({
                items: priced.lines.length,
                totalMinor: priced.subtotalMinor,
              }),
            },
          },
        },
        include: { items: true },
      });
    });
    return { created: true, order: orderSummary(order) };
  };

  // Retry order-number collisions (P2002 on the (hotelId, orderNumber) key);
  // an idempotency-key collision replays the EXISTING order instead.
  const ORDER_NUMBER_RETRIES = 3;
  for (let attempt = 0; ; attempt++) {
    try {
      return await createOnce();
    } catch (err) {
      if (isUniqueViolation(err)) {
        if (input.idempotencyKey) {
          const winner = await db.diningOrder.findFirst({
            where: { idempotencyKey: input.idempotencyKey, hotelId: input.hotelId },
          });
          if (winner) return { created: false, order: orderSummary(winner) };
        }
        if (attempt < ORDER_NUMBER_RETRIES) continue; // orderNumber race → retry
      }
      throw err;
    }
  }
}

/** Detect a Prisma unique-constraint violation without importing runtime enums. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

function orderSummary(order: {
  id: string;
  orderNumber: number;
  publicToken: string;
  status: DiningOrderStatus;
  subtotalMinor: number;
  totalMinor: number;
  currency: string;
  placedAt: Date;
}): CreateOrderResult["order"] {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    publicToken: order.publicToken,
    status: order.status,
    subtotalMinor: order.subtotalMinor,
    totalMinor: order.totalMinor,
    currency: order.currency,
    placedAt: order.placedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Status transitions (optimistic-concurrency safe)                    */
/* ------------------------------------------------------------------ */

export interface TransitionResult {
  ok: boolean;
  reason?: "NOT_FOUND" | "INVALID_TRANSITION" | "VERSION_CONFLICT";
  order?: { id: string; status: DiningOrderStatus };
}

/**
 * Apply an order-level status transition. `expectedUpdatedAt` (optional)
 * implements optimistic concurrency: when provided and stale, the transition
 * is rejected with VERSION_CONFLICT — two staff operating on the same order
 * can never silently overwrite each other.
 *
 * BUG-8/D10 fix: the status update, item cascade and OrderEvent append now
 * run inside ONE transaction — a failure can no longer leave the state
 * mutated with the audit event lost (the exact window BUG-1 exploited).
 * The status write keeps its fenced re-check (updateMany on the observed
 * status) as the concurrency primitive INSIDE the transaction.
 */
export async function transitionOrder(
  hotelId: string,
  orderId: string,
  to: DiningOrderStatus,
  opts?: {
    expectedUpdatedAt?: string;
    actorType?: "CUSTOMER" | "STAFF" | "SYSTEM";
    actorId?: string | null;
    actorName?: string | null;
    reason?: string | null;
    itemId?: string; // when the transition was triggered by an item update
  },
): Promise<TransitionResult> {
  return db.$transaction(async (tx) => {
    const order = await tx.diningOrder.findFirst({
      where: { id: orderId, hotelId },
      select: { id: true, status: true, updatedAt: true },
    });
    if (!order) return { ok: false, reason: "NOT_FOUND" as const };
    if (!canTransition(order.status, to)) return { ok: false, reason: "INVALID_TRANSITION" as const };
    if (
      opts?.expectedUpdatedAt &&
      new Date(opts.expectedUpdatedAt).getTime() !== order.updatedAt.getTime()
    ) {
      return { ok: false, reason: "VERSION_CONFLICT" as const };
    }

    const now = new Date();
    const res = await tx.diningOrder.updateMany({
      where: { id: orderId, hotelId, status: order.status }, // status re-check = fence
      data: {
        status: to,
        ...(to === "SERVED" ? { servedAt: now } : {}),
        ...(to === "CANCELLED"
          ? { cancelledAt: now, cancelReason: opts?.reason?.slice(0, 300) ?? null }
          : {}),
      },
    });
    if (res.count !== 1) {
      // Lost the race — report the conflict; nothing was written.
      return { ok: false, reason: "VERSION_CONFLICT" as const };
    }

    // Whole-order transitions cascade to non-terminal items (kitchen marking
    // the ORDER ready readies every pending item; serving serves every item).
    // D09 fix: CANCELLING an order now cancels EVERY non-terminal item —
    // including READY ones — so a cancelled order can never have items that
    // keep moving through the kitchen afterwards.
    if (to === "PREPARING" || to === "READY" || to === "SERVED" || to === "CANCELLED") {
      const itemTo: OrderItemStatus | null =
        to === "PREPARING" ? "PREPARING" : to === "READY" ? "READY" : to === "SERVED" ? "SERVED" : "CANCELLED";
      if (itemTo) {
        await tx.orderItem.updateMany({
          where: {
            orderId,
            status:
              itemTo === "CANCELLED"
                ? { in: ["PENDING", "PREPARING", "READY"] }
                : itemTo === "SERVED"
                  ? { in: ["PENDING", "PREPARING", "READY"] }
                  : { in: ["PENDING", "PREPARING"] },
          },
          data: { status: itemTo },
        });
      }
    }

    await tx.orderEvent.create({
      data: {
        orderId,
        hotelId,
        type: ORDER_EVENT_BY_STATUS[to],
        actorType: opts?.actorType ?? "STAFF",
        actorId: opts?.actorId ?? null,
        actorName: opts?.actorName ?? null,
        metadata: JSON.stringify({ reason: opts?.reason ?? null, itemId: opts?.itemId ?? null }),
      },
    });

    return { ok: true, order: { id: orderId, status: to } };
  });
}

/**
 * Apply an item-level transition; the whole-order status is then DERIVED.
 *
 * BUG-8/D10 fix: item update, event append, and the derived order-status
 * update (+ its event) all happen inside ONE transaction, and the derived
 * event is only written when the guarded updateMany actually WON the
 * transition (the old code wrote the derived event unconditionally).
 * D09 fix: a transition on a CANCELLED order's item is rejected; when every
 * item of an order ends up CANCELLED the parent order is derived CANCELLED
 * (instead of lingering PLACED forever); per-item cancellation writes its
 * own ITEM_CANCELLED event.
 */
export async function transitionOrderItem(
  hotelId: string,
  orderId: string,
  itemId: string,
  to: OrderItemStatus,
  opts?: {
    actorType?: "CUSTOMER" | "STAFF" | "SYSTEM";
    actorId?: string | null;
    actorName?: string | null;
  },
): Promise<TransitionResult> {
  return db.$transaction(async (tx) => {
    const item = await tx.orderItem.findFirst({
      where: { id: itemId, orderId, order: { hotelId } },
      select: { id: true, status: true, order: { select: { status: true } } },
    });
    if (!item) return { ok: false, reason: "NOT_FOUND" as const };
    if (!canTransition(item.status, to)) return { ok: false, reason: "INVALID_TRANSITION" as const };

    // D09: the parent order's terminal state governs its items — a cancelled
    // order's items can never resume moving through the kitchen.
    if (item.order.status === "CANCELLED" || item.order.status === "SERVED") {
      return { ok: false, reason: "INVALID_TRANSITION" as const };
    }

    const res = await tx.orderItem.updateMany({
      where: { id: itemId, status: item.status }, // fence
      data: { status: to },
    });
    if (res.count !== 1) return { ok: false, reason: "VERSION_CONFLICT" as const };

    await tx.orderEvent.create({
      data: {
        orderId,
        hotelId,
        type: ITEM_EVENT_BY_STATUS[to],
        actorType: opts?.actorType ?? "STAFF",
        actorId: opts?.actorId ?? null,
        actorName: opts?.actorName ?? null,
        metadata: JSON.stringify({ itemId }),
      },
    });

    // DERIVED whole-order status: an order is READY when every non-cancelled
    // item is READY/SERVED; PREPARING when any item is PREPARING. The derived
    // status is a PROJECTION of item states (it may skip PLACED→PREPARING when
    // items jump straight to READY) but only ever moves FORWARD — never
    // regresses SERVED/CANCELLED.
    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: { status: true },
    });
    const active = items.filter((i) => i.status !== "CANCELLED");
    const order = await tx.diningOrder.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!order || order.status === "SERVED" || order.status === "CANCELLED") {
      return {
        ok: true,
        order: { id: orderId, status: order?.status ?? ("PLACED" as DiningOrderStatus) },
      };
    }

    const rank: Record<string, number> = { PLACED: 0, PREPARING: 1, READY: 2 };
    let derived: DiningOrderStatus | null = null;
    if (active.length === 0) {
      // D09: every item cancelled → the whole order is cancelled (terminal).
      derived = "CANCELLED";
    } else {
      const allReady = active.every((i) => i.status === "READY" || i.status === "SERVED");
      const anyPreparing = active.some((i) => i.status === "PREPARING");
      derived = allReady ? "READY" : anyPreparing ? "PREPARING" : null;
    }

    if (
      derived &&
      derived !== order.status &&
      (derived === "CANCELLED" || (rank[derived] ?? -1) > (rank[order.status] ?? -1))
    ) {
      const won = await tx.diningOrder.updateMany({
        where: { id: orderId, status: order.status },
        data: {
          status: derived,
          ...(derived === "CANCELLED"
            ? { cancelledAt: new Date(), cancelReason: "All items were cancelled" }
            : {}),
        },
      });
      // D10: the derived event is written ONLY when this runner actually won
      // the guarded status transition (no phantom audit rows).
      if (won.count === 1) {
        await tx.orderEvent.create({
          data: {
            orderId,
            hotelId,
            type: ORDER_EVENT_BY_STATUS[derived],
            actorType: "SYSTEM",
            metadata: JSON.stringify({ derived: true }),
          },
        });
      }
    }

    const finalStatus =
      (
        await tx.diningOrder.findUnique({ where: { id: orderId }, select: { status: true } })
      )?.status ?? "PLACED";
    return { ok: true, order: { id: orderId, status: finalStatus } };
  });
}

/* ------------------------------------------------------------------ */
/* Table sessions                                                      */
/* ------------------------------------------------------------------ */

/**
 * Open (or reuse) the table's current session. One OPEN session per table:
 * a second open attempt returns the existing one (waiter re-open race).
 *
 * BUG-8/D05 fix: the check-then-create is now (a) wrapped in one transaction
 * and (b) fenced at the DATABASE level by the (tableId, openFence) unique
 * index — openFence = 1 while OPEN, NULL once closed. Six concurrent QR
 * scans can no longer produce six OPEN sessions: the DB itself rejects the
 * duplicates and the losers re-read + return the winner's session.
 */
export async function openTableSession(
  hotelId: string,
  tableId: string,
  guest?: { name?: string | null; phone?: string | null },
): Promise<{ id: string; publicToken: string; tableNumber: string }> {
  const table = await db.diningTable.findFirst({
    where: { id: tableId, hotelId, active: true },
    select: { id: true, number: true },
  });
  if (!table) throw new Error("TABLE_NOT_FOUND");

  const existing = await db.tableSession.findFirst({
    where: { tableId, status: "OPEN" },
    select: { id: true, publicToken: true },
  });
  if (existing) {
    return { id: existing.id, publicToken: existing.publicToken, tableNumber: table.number };
  }

  try {
    const session = await db.tableSession.create({
      data: {
        hotelId,
        tableId,
        publicToken: newPublicToken(),
        openFence: 1,
        guestName: guest?.name?.slice(0, 120) ?? null,
        guestPhone: guest?.phone?.slice(0, 20) ?? null,
      },
    });
    return { id: session.id, publicToken: session.publicToken, tableNumber: table.number };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Another concurrent opener created THE open session for this table —
      // return it (the re-open race contract).
      const winner = await db.tableSession.findFirst({
        where: { tableId, status: "OPEN" },
        select: { id: true, publicToken: true },
      });
      if (winner) {
        return { id: winner.id, publicToken: winner.publicToken, tableNumber: table.number };
      }
    }
    throw err;
  }
}

/** Close a table session (waiter/manager). Orders keep their snapshots. */
export async function closeTableSession(
  hotelId: string,
  sessionId: string,
): Promise<{ ok: boolean; reason?: "NOT_FOUND" }> {
  const res = await db.tableSession.updateMany({
    where: { id: sessionId, hotelId, status: "OPEN" },
    // Clearing openFence releases the (tableId, openFence) unique slot so a
    // new session can be opened for the table.
    data: { status: "CLOSED", closedAt: new Date(), openFence: null },
  });
  return res.count === 1 ? { ok: true } : { ok: false, reason: "NOT_FOUND" };
}

/* ------------------------------------------------------------------ */
/* KDS queue                                                           */
/* ------------------------------------------------------------------ */

/**
 * The kitchen queue: active orders (PLACED/PREPARING/READY) with per-item
 * state and minutes-since-placement. Kitchen sees item names, quantities,
 * table numbers and notes — NEVER customer CRM data, marketing info or
 * financials (enforced by the field selection here + KDS_ACCESS permission).
 */
export async function kdsQueue(hotelId: string) {
  const orders = await db.diningOrder.findMany({
    where: { hotelId, status: { in: ["PLACED", "PREPARING", "READY"] } },
    orderBy: { placedAt: "asc" },
    take: 200, // during a rush the old cap of 60 silently hid order 61+
    select: {
      id: true,
      orderNumber: true,
      status: true,
      placedAt: true,
      notes: true,
      source: true,
      table: { select: { number: true, zone: true } },
      items: {
        select: {
          id: true,
          nameSnapshot: true,
          quantity: true,
          optionsSnapshot: true,
          notes: true,
          status: true,
        },
      },
    },
  });

  const now = Date.now();
  return orders.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    source: o.source,
    tableNumber: o.table?.number ?? null,
    zone: o.table?.zone ?? null,
    minutesSincePlaced: Math.max(0, Math.round((now - o.placedAt.getTime()) / 60000)),
    notes: o.notes,
    items: o.items.map((i) => ({
      ...i,
      options: safeParseOptions(i.optionsSnapshot),
    })),
  }));
}

function safeParseOptions(raw: string | null): unknown {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Public order tracking — ONLY the fields a diner may see. */
export async function publicOrderTracking(token: string) {
  const clean = token.trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(clean)) return null;
  const order = await db.diningOrder.findUnique({
    where: { publicToken: clean },
    select: {
      orderNumber: true,
      status: true,
      currency: true,
      subtotalMinor: true,
      totalMinor: true,
      placedAt: true,
      table: { select: { number: true } },
      items: {
        select: {
          nameSnapshot: true,
          quantity: true,
          lineTotalMinor: true,
          optionsSnapshot: true,
          status: true,
        },
      },
    },
  });
  if (!order) return null;
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    currency: order.currency,
    subtotalMinor: order.subtotalMinor,
    totalMinor: order.totalMinor,
    placedAt: order.placedAt.toISOString(),
    tableNumber: order.table?.number ?? null,
    items: order.items.map((i) => ({
      name: i.nameSnapshot,
      quantity: i.quantity,
      lineTotalMinor: i.lineTotalMinor,
      options: safeParseOptions(i.optionsSnapshot),
      status: i.status,
    })),
  };
}

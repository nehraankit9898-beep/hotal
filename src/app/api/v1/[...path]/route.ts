/**
 * Phase 11 — Public developer API gateway: /api/v1/*
 *
 * Auth: API key (sk_live_…) via `Authorization: Bearer` or `X-API-Key`.
 * Every response is JSON with a stable envelope:
 *   success → { data: …, meta?: … }
 *   error   → { error: { code, message } }
 *
 * Endpoints (all tenant-scoped to the key's hotel):
 *   GET    /api/v1                    → endpoint index
 *   GET    /api/v1/customers          ?q=&page=&pageSize=       (read)
 *   POST   /api/v1/customers          { name, phone, email?, marketingConsent? } (write)
 *   GET    /api/v1/customers/[id]                               (read)
 *   GET    /api/v1/visits             ?phone=&page=&pageSize=   (read)
 *   POST   /api/v1/visits             { phone, checkin, checkout? } (write)
 *   GET    /api/v1/loyalty            ?phone=                   (read)
 *   GET    /api/v1/stats                                        (read)
 *
 * Security:
 *  - Key hash lookup (sha256) + ACTIVE check + hotel suspension check.
 *  - Scope enforcement: read endpoints need "read", mutating need "write".
 *  - Simple in-memory rate limit per key (120 req/min).
 *  - Usage metered to the plan (apiRequests) + per-key request counter.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { parseCsvDate } from "@/lib/csv";
import { authenticateApiKey, requireScope } from "@/lib/api-keys";
import { createCustomerWithinLimit } from "@/lib/saas/limits";

type Ctx = { params: Promise<{ path: string[] }> };

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function json(data: unknown, status = 200, meta?: Record<string, unknown>) {
  return NextResponse.json(meta ? { data, meta } : { data }, { status });
}

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function rateLimited(keyId: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(keyId);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(keyId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  const segments = (path ?? []).filter(Boolean);
  const method = req.method.toUpperCase();
  const url = new URL(req.url);

  // ---- Authenticate every /api/v1 request ----
  const authResult = await authenticateApiKey(req);
  if (!authResult.ok) {
    return err(authResult.status, authResult.code, authResult.message);
  }
  const auth = authResult.auth;

  if (rateLimited(auth.keyId)) {
    return NextResponse.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests — limit is 120 per minute per key.",
        },
      },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const [resource, sub] = segments;
  const readOnly = method === "GET";
  if (!requireScope(auth, readOnly ? "read" : "write")) {
    return err(
      403,
      "SCOPE_MISSING",
      `This API key does not have the "${readOnly ? "read" : "write"}" scope. Create a key with broader scopes or edit its scopes.`,
    );
  }

  // Common pagination params (used by list endpoints). Bound pageSize to [1, 100].
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "25", 10) || 25),
  );

  try {
    // ---- GET /api/v1 — self-describing index ----
    if (!resource && readOnly) {
      return json({
        name: "RestroLoop Developer API",
        version: "v1",
        hotel: auth.hotelName,
        endpoints: [
          {
            method: "GET",
            path: "/api/v1/customers",
            description: "List customers (q, page, pageSize)",
          },
          {
            method: "POST",
            path: "/api/v1/customers",
            description: "Create a customer (name, phone)",
          },
          { method: "GET", path: "/api/v1/customers/{id}", description: "Get one customer" },
          {
            method: "GET",
            path: "/api/v1/visits",
            description: "List visits (phone, page, pageSize)",
          },
          {
            method: "POST",
            path: "/api/v1/visits",
            description: "Record a visit (phone, checkin)",
          },
          {
            method: "GET",
            path: "/api/v1/loyalty?phone=",
            description: "Loyalty balance for a phone",
          },
          { method: "GET", path: "/api/v1/stats", description: "Basic hotel totals" },
          // Phase 17 — Enterprise restaurant endpoints (read-only)
          { method: "GET", path: "/api/v1/menu", description: "List active menu items (page, pageSize)" },
          { method: "GET", path: "/api/v1/tables", description: "List active dining tables (page, pageSize)" },
          { method: "GET", path: "/api/v1/orders", description: "List orders (page, pageSize)" },
          { method: "GET", path: "/api/v1/bills?status=", description: "List bills, optional status filter" },
          { method: "GET", path: "/api/v1/reservations", description: "List reservations (page, pageSize)" },
          { method: "GET", path: "/api/v1/inventory", description: "List ingredients and current stock" },
          { method: "GET", path: "/api/v1/branches", description: "List sibling branches in the franchise group" },
          { method: "GET", path: "/api/v1/health", description: "Service health + API key info" },
        ],
      });
    }

    // ---- /api/v1/customers ----
    if (resource === "customers") {
      if (method === "POST" && !sub) {
        const body = await req.json().catch(() => null);
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        const phoneRaw = typeof body?.phone === "string" ? body.phone.trim() : "";
        if (!name) return err(422, "VALIDATION_ERROR", "'name' is required.");
        const phoneResult = normalizePhone(phoneRaw);
        if (!phoneResult.ok)
          return err(422, "VALIDATION_ERROR", phoneResult.error || "Invalid 'phone'.");
        const phone = phoneResult.normalized!;

        const existing = await db.customer.findUnique({
          where: { hotelId_phone: { hotelId: auth.hotelId, phone } },
        });
        if (existing)
          return err(409, "ALREADY_EXISTS", `A customer with phone ${phone} already exists.`);

        // AUDIT FIX (F16) + RECHECK FIX (I): the plan's customer limit is
        // enforced on EVERY write path ATOMICALLY with the create — the old
        // pre-check + insert pair let concurrent API calls bypass the cap.
        const consent = body?.marketingConsent === true;
        const result = await createCustomerWithinLimit(auth.hotelId, (tx) =>
          tx.customer.create({
            data: {
              hotelId: auth.hotelId,
              name,
              phone,
              email:
                typeof body?.email === "string" && body.email.includes("@")
                  ? body.email.trim()
                  : null,
              marketingConsent: consent,
              consentTimestamp: consent ? new Date() : null,
              consentSource: consent ? "API" : null,
              source: "API",
            },
            select: {
              id: true,
              name: true,
              phone: true,
              email: true,
              marketingConsent: true,
              createdAt: true,
            },
          }),
        );
        if (!result.ok) return err(403, result.failure.code, result.failure.message);
        return json(result.value, 201);
      }

      if (method === "GET" && sub) {
        const customer = await db.customer.findFirst({
          where: { id: sub, hotelId: auth.hotelId },
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            marketingConsent: true,
            vip: true,
            loyaltyPoints: true,
            leadScore: true,
            leadTier: true,
            totalRestaurantVisits: true,
            totalRestaurantSpend: true,
            createdAt: true,
            visits: {
              orderBy: { checkin: "desc" },
              take: 10,
              select: { id: true, checkin: true, checkout: true, amount: true },
            },
          },
        });
        if (!customer) return err(404, "NOT_FOUND", "No customer with this id in your hotel.");
        return json(customer);
      }

      if (method === "GET") {
        const q = url.searchParams.get("q")?.trim() ?? "";
        const where = {
          hotelId: auth.hotelId,
          ...(q
            ? {
                OR: [
                  { name: { contains: q } },
                  { phone: { contains: q } },
                  { email: { contains: q } },
                ],
              }
            : {}),
        };
        const [total, customers] = await Promise.all([
          db.customer.count({ where }),
          db.customer.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * pageSize,
            take: pageSize,
            select: {
              id: true,
              name: true,
              phone: true,
              email: true,
              marketingConsent: true,
              vip: true,
              loyaltyPoints: true,
              leadTier: true,
              createdAt: true,
            },
          }),
        ]);
        return json(customers, 200, {
          total,
          page,
          pageSize,
          pages: Math.max(1, Math.ceil(total / pageSize)),
        });
      }
    }

    // ---- /api/v1/visits ----
    if (resource === "visits") {
      if (method === "POST" && !sub) {
        const body = await req.json().catch(() => null);
        const phoneRaw = typeof body?.phone === "string" ? body.phone.trim() : "";
        const phoneResult = normalizePhone(phoneRaw);
        if (!phoneResult.ok)
          return err(422, "VALIDATION_ERROR", phoneResult.error || "Invalid 'phone'.");
        const customer = await db.customer.findUnique({
          where: { hotelId_phone: { hotelId: auth.hotelId, phone: phoneResult.normalized! } },
        });
        if (!customer) {
          return err(404, "NOT_FOUND", "No customer with this phone. Create the customer first.");
        }
        const checkin = parseCsvDate(typeof body?.checkin === "string" ? body.checkin : "");
        if (!checkin) return err(422, "VALIDATION_ERROR", "'checkin' is required (YYYY-MM-DD).");
        const checkoutRaw = typeof body?.checkout === "string" ? body.checkout : "";
        let checkout: Date | null = null;
        if (checkoutRaw) {
          checkout = parseCsvDate(checkoutRaw);
          if (!checkout) return err(422, "VALIDATION_ERROR", "'checkout' is invalid (YYYY-MM-DD).");
          if (checkout < checkin)
            return err(422, "VALIDATION_ERROR", "'checkout' is before 'checkin'.");
        }
        const amount =
          typeof body?.amount === "number" && isFinite(body.amount) && body.amount >= 0
            ? body.amount
            : null;

        const dup = await db.visit.findFirst({
          where: { hotelId: auth.hotelId, customerId: customer.id, checkin },
        });
        if (dup)
          return err(
            409,
            "ALREADY_EXISTS",
            "A visit with this check-in date already exists for this customer.",
          );

        const visit = await db.visit.create({
          data: {
            hotelId: auth.hotelId,
            customerId: customer.id,
            checkin,
            checkout,
            amount,
            source: "API",
            notes: typeof body?.notes === "string" ? body.notes.slice(0, 500) : null,
          },
          select: { id: true, checkin: true, checkout: true, amount: true, createdAt: true },
        });
        return json(visit, 201);
      }

      if (method === "GET") {
        const phone = url.searchParams.get("phone")?.trim() ?? "";
        let customerId: string | null = null;
        if (phone) {
          const phoneResult = normalizePhone(phone);
          if (!phoneResult.ok)
            return err(422, "VALIDATION_ERROR", phoneResult.error || "Invalid 'phone'.");
          const customer = await db.customer.findUnique({
            where: { hotelId_phone: { hotelId: auth.hotelId, phone: phoneResult.normalized! } },
            select: { id: true },
          });
          if (!customer) return json([], 200, { total: 0, page, pageSize, pages: 1 });
          customerId = customer.id;
        }
        const where = { hotelId: auth.hotelId, ...(customerId ? { customerId } : {}) };
        const [total, visits] = await Promise.all([
          db.visit.count({ where }),
          db.visit.findMany({
            where,
            orderBy: { checkin: "desc" },
            skip: (page - 1) * pageSize,
            take: pageSize,
            select: {
              id: true,
              customerId: true,
              checkin: true,
              checkout: true,
              amount: true,
              source: true,
              customer: { select: { name: true, phone: true } },
            },
          }),
        ]);
        return json(visits, 200, {
          total,
          page,
          pageSize,
          pages: Math.max(1, Math.ceil(total / pageSize)),
        });
      }
    }

    // ---- /api/v1/loyalty?phone= ----
    if (resource === "loyalty" && method === "GET") {
      const phone = url.searchParams.get("phone")?.trim() ?? "";
      if (!phone) return err(422, "VALIDATION_ERROR", "'phone' query parameter is required.");
      const phoneResult = normalizePhone(phone);
      if (!phoneResult.ok)
        return err(422, "VALIDATION_ERROR", phoneResult.error || "Invalid 'phone'.");
      const account = await db.loyaltyAccount.findFirst({
        where: { hotelId: auth.hotelId, customer: { phone: phoneResult.normalized! } },
        select: {
          points: true,
          tier: true,
          updatedAt: true,
          customer: { select: { id: true, name: true, phone: true } },
        },
      });
      if (!account) return err(404, "NOT_FOUND", "No loyalty account for this phone number.");
      return json(account);
    }

    // ---- /api/v1/stats ----
    if (resource === "stats" && method === "GET" && !sub) {
      const [customers, visits, activeCampaigns] = await Promise.all([
        db.customer.count({ where: { hotelId: auth.hotelId } }),
        db.visit.count({ where: { hotelId: auth.hotelId } }),
        db.campaign.count({ where: { hotelId: auth.hotelId, status: "ACTIVE" } }),
      ]);
      return json({ customers, visits, activeCampaigns });
    }

    // ---- Phase 17 — Enterprise restaurant endpoints ----
    // GET /api/v1/menu       — list active menu items
    // GET /api/v1/tables     — list active dining tables
    // GET /api/v1/orders     — list orders (paginated)
    // GET /api/v1/bills      — list bills (optional ?status= filter)
    // GET /api/v1/reservations — list upcoming reservations
    // GET /api/v1/inventory  — list ingredients and current stock
    // GET /api/v1/branches   — list sibling branches in the franchise group
    // GET /api/v1/health     — service health + API key info
    if (resource === "menu" && method === "GET" && !sub) {
      const { enterpriseListMenu } = await import("@/lib/enterprise-api");
      const result = await enterpriseListMenu(auth.hotelId, page, pageSize);
      return json(result.items, 200, {
        total: result.total,
        page,
        pageSize,
        pages: Math.max(1, Math.ceil(result.total / pageSize)),
      });
    }

    if (resource === "tables" && method === "GET" && !sub) {
      const { enterpriseListTables } = await import("@/lib/enterprise-api");
      const result = await enterpriseListTables(auth.hotelId, page, pageSize);
      return json(result.tables, 200, {
        total: result.total,
        page,
        pageSize,
        pages: Math.max(1, Math.ceil(result.total / pageSize)),
      });
    }

    if (resource === "orders" && method === "GET" && !sub) {
      const { enterpriseListOrders } = await import("@/lib/enterprise-api");
      const result = await enterpriseListOrders(auth.hotelId, page, pageSize);
      return json(result.orders, 200, {
        total: result.total,
        page,
        pageSize,
        pages: Math.max(1, Math.ceil(result.total / pageSize)),
      });
    }

    if (resource === "bills" && method === "GET" && !sub) {
      const { enterpriseListBills } = await import("@/lib/enterprise-api");
      const statusParam = url.searchParams.get("status") ?? undefined;
      // Coerce to the BillStatus union; invalid values are dropped (no filter).
      const validStatuses = ["ISSUED", "PARTIALLY_PAID", "PARTIALLY_REFUNDED", "REFUNDED", "PAID", "VOID"];
      const status = statusParam && validStatuses.includes(statusParam)
        ? (statusParam as "ISSUED" | "PARTIALLY_PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" | "PAID" | "VOID")
        : undefined;
      const result = await enterpriseListBills(auth.hotelId, page, pageSize, status);
      return json(result.bills, 200, {
        total: result.total,
        page,
        pageSize,
        pages: Math.max(1, Math.ceil(result.total / pageSize)),
      });
    }

    if (resource === "reservations" && method === "GET" && !sub) {
      const { enterpriseListReservations } = await import("@/lib/enterprise-api");
      const result = await enterpriseListReservations(auth.hotelId, page, pageSize);
      return json(result.reservations, 200, {
        total: result.total,
        page,
        pageSize,
        pages: Math.max(1, Math.ceil(result.total / pageSize)),
      });
    }

    if (resource === "inventory" && method === "GET" && !sub) {
      const { enterpriseListInventory } = await import("@/lib/enterprise-api");
      const result = await enterpriseListInventory(auth.hotelId, page, pageSize);
      return json(result.ingredients, 200, {
        total: result.total,
        page,
        pageSize,
        pages: Math.max(1, Math.ceil(result.total / pageSize)),
      });
    }

    if (resource === "branches" && method === "GET" && !sub) {
      const { enterpriseListBranches } = await import("@/lib/enterprise-api");
      const result = await enterpriseListBranches(auth.hotelId);
      return json(result.branches, 200, { total: result.branches.length });
    }

    if (resource === "health" && method === "GET" && !sub) {
      const { enterpriseHealth } = await import("@/lib/enterprise-api");
      const result = await enterpriseHealth({
        keyId: auth.keyId,
        hotelId: auth.hotelId,
        hotelName: auth.hotelName,
        scopes: auth.scopes,
      });
      return json(result);
    }

    return err(
      404,
      "NOT_FOUND",
      `Unknown endpoint: ${method} /api/v1/${segments.join("/")}. GET /api/v1 lists endpoints.`,
    );
  } catch (e) {
    console.error("[api/v1]", e);
    return err(500, "SERVER_ERROR", "Something went wrong processing this request.");
  }
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;

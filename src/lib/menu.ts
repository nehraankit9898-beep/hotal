/**
 * Phase 12 — Digital menu & table management service.
 *
 * Server-side validation for the tenant-scoped menu catalog:
 *  - money is INTEGER MINOR UNITS (paise) — never floats, never negative;
 *  - option groups carry required/min/max constraints that the SERVER
 *    re-validates on every order submit (Phase 13 ordering trusts nothing
 *    the client computed);
 *  - plan limits (menuItems cap) are enforced ATOMICALLY inside the create
 *    transaction so two concurrent creates cannot both pass the cap check.
 */

import { db } from "@/lib/db";

export const MAX_MENU_ITEMS = 500; // hard platform ceiling (plan cap may be lower)
export const MAX_TABLES = 200;

export interface OptionGroupInput {
  name: string;
  required?: boolean;
  minSelect?: number;
  maxSelect?: number;
  sortOrder?: number;
  active?: boolean;
  options: {
    name: string;
    priceDeltaMinor?: number;
    sortOrder?: number;
    active?: boolean;
  }[];
}

export interface MenuValidationIssue {
  field: string;
  message: string;
}

/** Validate + normalize a menu item payload. Returns issues (empty = ok). */
export function validateMenuItem(
  body: Record<string, unknown>,
): { issues: MenuValidationIssue[]; value?: ItemInput } {
  const issues: MenuValidationIssue[] = [];
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 2 || name.length > 120) {
    issues.push({ field: "name", message: "Item name must be 2-120 characters." });
  }
  // BUG-7: priceMinor is REQUIRED and must be a finite non-negative integer.
  // `Number(body.priceMinor ?? 0)` used to silently turn an absent/null/
  // NaN price (the client computed NaN from "2.5.5", JSON.stringify turned
  // it into null) into a ₹0 item.
  const rawPrice = body.priceMinor;
  const priceMinor = Number(rawPrice);
  if (
    rawPrice === null ||
    rawPrice === undefined ||
    rawPrice === "" ||
    !Number.isFinite(priceMinor) ||
    !Number.isInteger(priceMinor) ||
    priceMinor < 0 ||
    priceMinor > 100_000_00
  ) {
    issues.push({
      field: "priceMinor",
      message:
        rawPrice === null || rawPrice === undefined || rawPrice === ""
          ? "A price is required (integer amount in paise)."
          : "Price must be an integer amount in paise (0 - 1,00,00,000).",
    });
  }
  const prepMinutes = Number(body.prepMinutes ?? 10);
  if (!Number.isInteger(prepMinutes) || prepMinutes < 1 || prepMinutes > 240) {
    issues.push({ field: "prepMinutes", message: "Prep time must be 1-240 minutes." });
  }
  const description =
    typeof body.description === "string" && body.description.trim()
      ? body.description.trim().slice(0, 1000)
      : null;
  const imageUrl =
    typeof body.imageUrl === "string" && body.imageUrl.trim() ? body.imageUrl.trim() : null;
  if (imageUrl && !/^https:\/\//i.test(imageUrl) && !/^\/api\/media\//.test(imageUrl)) {
    issues.push({
      field: "imageUrl",
      message: "Image URL must be an https:// URL or an uploaded media reference.",
    });
  }
  const dietaryTags = Array.isArray(body.dietaryTags)
    ? body.dietaryTags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim().toUpperCase())
        .filter((t) => ["VEG", "NON_VEG", "JAIN", "VEGAN", "SPICY"].includes(t))
    : [];
  if (issues.length > 0) return { issues };
  return {
    issues: [],
    value: {
      name,
      description,
      priceMinor,
      prepMinutes,
      imageUrl,
      dietaryTags: [...new Set(dietaryTags)],
      sortOrder: Number.isInteger(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
      active: body.active !== false,
      available: body.available !== false,
    },
  };
}

export interface ItemInput {
  name: string;
  description: string | null;
  priceMinor: number;
  prepMinutes: number;
  imageUrl: string | null;
  dietaryTags: string[];
  sortOrder: number;
  active: boolean;
  available: boolean;
}

/** Validate option groups (constraints the server enforces on order submit). */
export function validateOptionGroups(
  groups: unknown,
): { issues: MenuValidationIssue[]; value?: OptionGroupInput[] } {
  if (!Array.isArray(groups)) return { issues: [], value: [] };
  const issues: MenuValidationIssue[] = [];
  const cleaned: OptionGroupInput[] = [];
  groups.forEach((g, idx) => {
    if (typeof g !== "object" || g === null) {
      issues.push({ field: `groups[${idx}]`, message: "Invalid option group." });
      return;
    }
    const group = g as Record<string, unknown>;
    const name = typeof group.name === "string" ? group.name.trim() : "";
    if (name.length < 2 || name.length > 80) {
      issues.push({ field: `groups[${idx}].name`, message: "Group name must be 2-80 characters." });
    }
    const minSelect = Number(group.minSelect ?? 0);
    const maxSelect = Number(group.maxSelect ?? 1);
    if (!Number.isInteger(minSelect) || minSelect < 0 || minSelect > 20) {
      issues.push({ field: `groups[${idx}].minSelect`, message: "minSelect must be 0-20." });
    }
    if (!Number.isInteger(maxSelect) || maxSelect < 1 || maxSelect > 20) {
      issues.push({ field: `groups[${idx}].maxSelect`, message: "maxSelect must be 1-20." });
    }
    if (minSelect > maxSelect) {
      issues.push({
        field: `groups[${idx}]`,
        message: "minSelect cannot exceed maxSelect.",
      });
    }
    const options = Array.isArray(group.options) ? group.options : [];
    if (options.length === 0) {
      issues.push({ field: `groups[${idx}].options`, message: "A group needs at least one option." });
    }
    // D14: min/max must be satisfiable by the ACTIVE options only — a group
    // that hides options below its maxSelect would force dead choices on
    // diners (order-time validation only ever sees active options).
    const activeOptionCount = options.filter(
      (o) => typeof o === "object" && o !== null && (o as Record<string, unknown>).active !== false,
    ).length;
    if (activeOptionCount === 0 && options.length > 0) {
      issues.push({
        field: `groups[${idx}].options`,
        message: "A group needs at least one ACTIVE option (hide the whole group instead).",
      });
    }
    if (maxSelect > activeOptionCount && activeOptionCount > 0) {
      issues.push({
        field: `groups[${idx}].maxSelect`,
        message: "maxSelect cannot exceed the number of ACTIVE options.",
      });
    }
    const cleanOptions: OptionGroupInput["options"] = [];
    for (const o of options) {
      if (typeof o !== "object" || o === null) continue;
      const opt = o as Record<string, unknown>;
      const optName = typeof opt.name === "string" ? opt.name.trim() : "";
      if (optName.length < 1 || optName.length > 80) {
        issues.push({
          field: `groups[${idx}].options`,
          message: "Option names must be 1-80 characters.",
        });
        continue;
      }
      const priceDeltaMinor = Number(opt.priceDeltaMinor ?? 0);
      if (!Number.isInteger(priceDeltaMinor) || priceDeltaMinor < 0 || priceDeltaMinor > 100_000_00) {
        issues.push({
          field: `groups[${idx}].options`,
          message: "Option price adjustment must be an integer in paise (>= 0).",
        });
        continue;
      }
      cleanOptions.push({
        name: optName,
        priceDeltaMinor,
        sortOrder: Number.isInteger(Number(opt.sortOrder)) ? Number(opt.sortOrder) : 0,
        active: opt.active !== false,
      });
    }
    cleaned.push({
      name,
      required: group.required === true,
      minSelect,
      maxSelect,
      sortOrder: Number.isInteger(Number(group.sortOrder)) ? Number(group.sortOrder) : idx,
      active: group.active !== false,
      options: cleanOptions,
    });
  });
  if (issues.length > 0) return { issues };
  return { issues: [], value: cleaned };
}

/**
 * Resolve the PUBLIC menu a QR code points at (tenant + optional table).
 * Returns only catalog data that is safe for anonymous diners: no staff info,
 * no tenant settings beyond display fields, no other tables.
 */
export async function resolvePublicMenu(code: string) {
  const clean = code.trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clean)) return { ok: false as const, reason: "INVALID_CODE" };

  const qr = await db.qRCode.findUnique({
    where: { code: clean },
    include: {
      hotel: {
        select: {
          id: true,
          name: true,
          city: true,
          location: true,
          status: true,
          currency: true,
        },
      },
      table: true,
    },
  });
  if (!qr || !qr.active) return { ok: false as const, reason: "INACTIVE" };
  if (!qr.hotel || qr.hotel.status !== "ACTIVE") return { ok: false as const, reason: "INACTIVE" };
  if (qr.type !== "MENU" && qr.type !== "ORDER") {
    return { ok: false as const, reason: "NOT_MENU" };
  }

  const categories = await db.menuCategory.findMany({
    where: { hotelId: qr.hotelId, active: true },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      name: true,
      description: true,
      items: {
        where: { active: true },
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
          priceMinor: true,
          currency: true,
          dietaryTags: true,
          imageUrl: true,
          available: true,
          prepMinutes: true,
          optionGroups: {
            where: { active: true },
            orderBy: { sortOrder: "asc" },
            select: {
              id: true,
              name: true,
              required: true,
              minSelect: true,
              maxSelect: true,
              options: {
                where: { active: true },
                orderBy: { sortOrder: "asc" },
                select: {
                  id: true,
                  name: true,
                  priceDeltaMinor: true,
                },
              },
            },
          },
        },
      },
    },
  });

  return {
    ok: true as const,
    restaurant: qr.hotel,
    table: qr.table
      ? { id: qr.table.id, number: qr.table.number, zone: qr.table.zone }
      : null,
    categories: categories.map((c) => ({
      ...c,
      items: c.items.map((i) => ({
        ...i,
        dietaryTags: safeParseTags(i.dietaryTags),
      })),
    })),
  };
}

function safeParseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Plan-aware menu item cap. Uses the plan's DEDICATED `menuItemsLimit`
 * entitlement (BUG-7/D17 — this previously reused restaurantsLimit, the
 * number of restaurant LOCATIONS, so a plan allowing 1 location could only
 * ever have 1 menu item). 0 = unlimited, matching Plan semantics; a hard
 * platform ceiling still applies.
 */
export async function menuItemCapFor(hotelId: string): Promise<number> {
  const hotel = await db.hotel.findUnique({
    where: { id: hotelId },
    select: { plan: { select: { menuItemsLimit: true } } },
  });
  const planCap = hotel?.plan?.menuItemsLimit ?? 0;
  if (planCap <= 0) return MAX_MENU_ITEMS;
  return Math.min(planCap, MAX_MENU_ITEMS);
}

import { db } from "@/lib/db";
import { parseCsv, rowsToObjects, parseCsvDate } from "@/lib/csv";
import { guardCsvShape } from "@/lib/csv-guard";
import { normalizePhone } from "@/lib/phone";

/**
 * CSV import validation — shared by preview + import endpoints so
 * what the user previews is exactly what gets imported.
 * Invalid rows are NEVER silently discarded: every row gets a status + reason.
 */

export class CsvShapeError extends Error {}

export interface CustomerRow {
  row: number;
  name: string;
  phone: string;
  email: string;
  consent: boolean;
  status: "valid" | "duplicate" | "invalid";
  reason?: string;
}

export interface VisitRow {
  row: number;
  customerPhone: string;
  customerName?: string;
  checkin: string;
  checkout: string;
  status: "valid" | "invalid";
  reason?: string;
}

export function parseConsentValue(v: string): boolean | null {
  const s = (v || "").trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(s)) return true;
  if (["false", "no", "n", "0", ""].includes(s)) return false;
  return null; // unrecognized
}

/**
 * Ensure the CSV header actually contains the columns the importer needs —
 * otherwise every row fails with a confusing "missing phone" error. Fail fast
 * with a precise, actionable message instead.
 */
export function validateHeaderColumns(
  rows: Record<string, string>[],
  required: string[],
  kind: string,
): void {
  if (rows.length === 0) return; // empty file handled by callers
  const header = Object.keys(rows[0]);
  const missing = required.filter((col) => !(col in rows[0]));
  if (missing.length > 0) {
    throw new CsvShapeError(
      `Missing required ${kind} column${missing.length > 1 ? "s" : ""}: ${missing
        .map((c) => `"${c}"`)
        .join(
          ", ",
        )}. Found columns: ${header.join(", ")}. Download the template for the exact format.`,
    );
  }
}

/** Validate a customers CSV (name, phone, email, marketing_consent). */
export async function validateCustomerCsv(
  csvText: string,
  hotelId: string,
): Promise<{
  rows: CustomerRow[];
  summary: { total: number; valid: number; duplicates: number; invalid: number };
}> {
  const parsed = parseCsv(csvText);
  const shape = guardCsvShape(parsed);
  if (!shape.ok) throw new CsvShapeError(shape.reason ?? "CSV rejected.");
  const rows = rowsToObjects(parsed);
  validateHeaderColumns(rows, ["name", "phone"], "customer");
  const result: CustomerRow[] = [];
  const seenPhones = new Map<string, number>(); // phone → first row

  // Existing phones in this hotel (single query, tenant-scoped)
  const existing = await db.customer.findMany({
    where: { hotelId },
    select: { phone: true },
  });
  const existingPhones = new Set(existing.map((c) => c.phone));

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNumber = i + 2; // +1 header, +1 human numbering
    const name = (r.name || "").trim();
    const phone = (r.phone || "").trim();
    const email = (r.email || "").trim();
    const consentRaw = r.marketing_consent ?? r.consent ?? "";

    const entry: CustomerRow = {
      row: rowNumber,
      name,
      phone,
      email,
      consent: false,
      status: "valid",
    };

    if (!name) {
      result.push({ ...entry, status: "invalid", reason: "Name is missing." });
      continue;
    }

    const phoneResult = normalizePhone(phone);
    if (!phoneResult.ok) {
      result.push({
        ...entry,
        status: "invalid",
        reason: phoneResult.error || "Invalid phone number.",
      });
      continue;
    }
    const normalized = phoneResult.normalized!;
    entry.phone = normalized;

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      result.push({ ...entry, status: "invalid", reason: "Invalid email address." });
      continue;
    }

    const consent = parseConsentValue(consentRaw);
    if (consent === null) {
      result.push({
        ...entry,
        status: "invalid",
        reason: `Invalid marketing_consent value "${consentRaw}" — use yes/no, true/false or 1/0.`,
      });
      continue;
    }
    entry.consent = consent;

    // Duplicate inside the file itself
    const firstRow = seenPhones.get(normalized);
    if (firstRow !== undefined) {
      result.push({
        ...entry,
        status: "duplicate",
        reason: `Duplicate of row ${firstRow} (same phone number).`,
      });
      continue;
    }
    seenPhones.set(normalized, rowNumber);

    // Duplicate against existing customers
    if (existingPhones.has(normalized)) {
      result.push({
        ...entry,
        status: "duplicate",
        reason: "A customer with this phone number already exists.",
      });
      continue;
    }

    result.push(entry);
  }

  const summary = {
    total: result.length,
    valid: result.filter((r) => r.status === "valid").length,
    duplicates: result.filter((r) => r.status === "duplicate").length,
    invalid: result.filter((r) => r.status === "invalid").length,
  };
  return { rows: result, summary };
}

/** Validate a visits CSV (customer_phone, checkin, checkout). */
export async function validateVisitCsv(
  csvText: string,
  hotelId: string,
): Promise<{
  rows: VisitRow[];
  summary: { total: number; valid: number; invalid: number; newVisits: number };
}> {
  const parsed = parseCsv(csvText);
  const shape = guardCsvShape(parsed);
  if (!shape.ok) throw new CsvShapeError(shape.reason ?? "CSV rejected.");
  const rows = rowsToObjects(parsed);
  // Accept either "customer_phone" or "phone", and "checkin" or "check_in".
  const headerKeys = rows.length > 0 ? Object.keys(rows[0]) : [];
  const hasPhone = headerKeys.includes("customer_phone") || headerKeys.includes("phone");
  const hasCheckin = headerKeys.includes("checkin") || headerKeys.includes("check_in");
  const missingVisit: string[] = [];
  if (!hasPhone) missingVisit.push('"customer_phone" (or "phone")');
  if (!hasCheckin) missingVisit.push('"checkin"');
  if (missingVisit.length > 0) {
    throw new CsvShapeError(
      `Missing required visit column: ${missingVisit.join(", ")}. Found columns: ${headerKeys.join(", ")}. Download the template for the exact format.`,
    );
  }
  const result: VisitRow[] = [];

  const customers = await db.customer.findMany({
    where: { hotelId },
    select: { phone: true, name: true },
  });
  const phoneMap = new Map(customers.map((c) => [c.phone, c.name]));
  let newVisits = 0;

  // Perf fix: batch-load existing check-in dates for the phones referenced in
  // this file (single query) instead of one findFirst per row (N+1).
  const normalizedPhones = new Set<string>();
  for (const r of rows) {
    const phoneRaw = (r.customer_phone || r.phone || "").trim();
    const phoneResult = normalizePhone(phoneRaw);
    if (phoneResult.ok) normalizedPhones.add(phoneResult.normalized!);
  }
  const existingVisitKeys = new Set<string>();
  if (normalizedPhones.size > 0) {
    const existingVisits = await db.visit.findMany({
      where: { hotelId, customer: { phone: { in: [...normalizedPhones] } } },
      select: { checkin: true, customer: { select: { phone: true } } },
    });
    for (const v of existingVisits) {
      existingVisitKeys.add(`${v.customer.phone}:${v.checkin.toISOString().slice(0, 10)}`);
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNumber = i + 2;
    const phoneRaw = (r.customer_phone || r.phone || "").trim();
    const checkinRaw = (r.checkin || r.check_in || "").trim();
    const checkoutRaw = (r.checkout || r.check_out || "").trim();

    const entry: VisitRow = {
      row: rowNumber,
      customerPhone: phoneRaw,
      checkin: checkinRaw,
      checkout: checkoutRaw,
      status: "valid",
    };

    const phoneResult = normalizePhone(phoneRaw);
    if (!phoneResult.ok) {
      result.push({
        ...entry,
        status: "invalid",
        reason: phoneResult.error || "Invalid phone number.",
      });
      continue;
    }
    entry.customerPhone = phoneResult.normalized!;
    const customerName = phoneMap.get(phoneResult.normalized!);
    if (!customerName) {
      result.push({
        ...entry,
        status: "invalid",
        reason: "No customer found with this phone number. Import the customer first.",
      });
      continue;
    }
    entry.customerName = customerName;

    const checkin = parseCsvDate(checkinRaw);
    if (!checkin) {
      result.push({
        ...entry,
        status: "invalid",
        reason: `Invalid check-in date "${checkinRaw}" — use YYYY-MM-DD.`,
      });
      continue;
    }

    let checkout: Date | null = null;
    if (checkoutRaw) {
      checkout = parseCsvDate(checkoutRaw);
      if (!checkout) {
        result.push({
          ...entry,
          status: "invalid",
          reason: `Invalid check-out date "${checkoutRaw}" — use YYYY-MM-DD.`,
        });
        continue;
      }
      if (checkout < checkin) {
        result.push({ ...entry, status: "invalid", reason: "Check-out is before check-in." });
        continue;
      }
    }

    // Same customer + same check-in date = duplicate visit (batch-loaded above)
    if (existingVisitKeys.has(`${phoneResult.normalized!}:${checkin.toISOString().slice(0, 10)}`)) {
      result.push({
        ...entry,
        status: "invalid",
        reason: "A visit with this check-in date already exists for this customer.",
      });
      continue;
    }

    newVisits++;
    result.push(entry);
  }

  const summary = {
    total: result.length,
    valid: result.filter((r) => r.status === "valid").length,
    invalid: result.filter((r) => r.status === "invalid").length,
    newVisits,
  };
  return { rows: result, summary };
}

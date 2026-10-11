/**
 * Phase 7 — shared customer CSV builder used by both the inline export route
 * and the background CSV_EXPORT job (single source of truth, same output).
 * Formula-injection safe via sanitizeCsvRow.
 */

import { db } from "@/lib/db";
import { sanitizeCsvRow } from "@/lib/csv-guard";

function csvEscape(field: string): string {
  if (/[",\n\r]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

export async function buildCustomersCsv(hotelId: string): Promise<{ csv: string; rows: number }> {
  const customers = await db.customer.findMany({
    where: { hotelId },
    orderBy: { createdAt: "asc" },
    include: { loyaltyAccounts: true },
  });

  const header = [
    "Name",
    "Phone",
    "Email",
    "Marketing Consent",
    "Opted Out",
    "Visits",
    "Restaurant Visits",
    "Restaurant Spend",
    "Loyalty Points",
    "Loyalty Tier",
    "First Seen",
  ];

  // Visit counts per customer (grouped query — avoids loading all visits).
  const visitCounts = await db.visit.groupBy({
    by: ["customerId"],
    where: { hotelId },
    _count: { _all: true },
  });
  const visitMap = new Map(visitCounts.map((v) => [v.customerId, v._count._all]));

  const outRows = customers.map((c) =>
    sanitizeCsvRow([
      c.name,
      c.phone,
      c.email ?? "",
      c.marketingConsent ? "YES" : "NO",
      c.optOut ? "YES" : "NO",
      String(visitMap.get(c.id) ?? 0),
      String(c.totalRestaurantVisits),
      c.totalRestaurantSpend.toFixed(2),
      String(c.loyaltyAccounts[0]?.points ?? c.loyaltyPoints),
      c.loyaltyAccounts[0]?.tier ?? "BRONZE",
      c.createdAt.toISOString().slice(0, 10),
    ]),
  );

  const csv = [header, ...outRows]
    .map((row) => row.map((f) => csvEscape(f)).join(","))
    .join("\r\n");

  // UTF-8 BOM so Excel detects the encoding and renders non-ASCII names
  // (Hindi, accented Latin, CJK) correctly instead of mojibake.
  return { csv: "\uFEFF" + csv, rows: customers.length };
}

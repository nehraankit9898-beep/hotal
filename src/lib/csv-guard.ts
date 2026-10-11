/**
 * CSV security guards — Phase 19.
 *
 * - Size/row/column/field limits for imports (memory + DoS protection).
 * - Spreadsheet formula-injection neutralization for every CSV value that is
 *   exported back to users (import preview) or written to CSV files:
 *   values beginning with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`
 *   so spreadsheet apps treat them as text.
 */

import { MAX_CSV_BYTES, MAX_CSV_ROWS } from "@/lib/validation";

export const MAX_CSV_COLUMNS = 32;
export const MAX_CSV_FIELD_LENGTH = 500;

export interface CsvGuardResult {
  ok: boolean;
  reason?: string;
}

/** Enforce payload size + rough row limits BEFORE parsing. */
export function guardCsvPayload(csvText: string): CsvGuardResult {
  const bytes = Buffer.byteLength(csvText, "utf8");
  if (bytes > MAX_CSV_BYTES) {
    return {
      ok: false,
      reason: `CSV is too large (max ${Math.floor(MAX_CSV_BYTES / 1024 / 1024)} MB).`,
    };
  }
  const lineCount = csvText.split("\n").length;
  if (lineCount > MAX_CSV_ROWS + 1) {
    return { ok: false, reason: `CSV has too many rows (max ${MAX_CSV_ROWS} data rows).` };
  }
  return { ok: true };
}

/** Cap columns/field lengths after parsing; return null when out of policy. */
export function guardCsvShape(rows: string[][]): CsvGuardResult {
  for (const row of rows) {
    if (row.length > MAX_CSV_COLUMNS) {
      return { ok: false, reason: `CSV has too many columns (max ${MAX_CSV_COLUMNS}).` };
    }
    for (const field of row) {
      if (field.length > MAX_CSV_FIELD_LENGTH) {
        return {
          ok: false,
          reason: `A CSV field exceeds the maximum length of ${MAX_CSV_FIELD_LENGTH} characters.`,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Neutralize spreadsheet formula injection for a single CSV cell.
 * Dangerous prefixes: = + - @ \t \r (OWASP CSV injection guidance).
 */
export function sanitizeCsvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) {
    return `'${s}`;
  }
  return s;
}

/** Sanitize a full row (used by import preview + any CSV export). */
export function sanitizeCsvRow(values: unknown[]): string[] {
  return values.map((v) => sanitizeCsvCell(v));
}

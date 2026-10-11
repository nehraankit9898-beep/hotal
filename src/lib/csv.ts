/**
 * Minimal RFC-4180 compliant CSV parser (handles quoted fields, escaped quotes, CRLF).
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  // last field/row
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop fully empty trailing rows
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/** Convert rows to objects using the header row (trimmed, lowercased, underscores). */
export function rowsToObjects(rows: string[][]): Record<string, string>[] {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
  );
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const obj: Record<string, string> = {};
    header.forEach((key, idx) => {
      obj[key] = (rows[r][idx] ?? "").trim();
    });
    out.push(obj);
  }
  return out;
}

/**
 * Parse flexible date input: ISO (2025-01-15), ISO datetime, or 2025-01-15 14:30,
 * or slash dates: DD/MM/YYYY (default) and MM/DD/YYYY (auto-detected when the
 * second component cannot be a day, e.g. 12/25/2025).
 */
export function parseCsvDate(value: string): Date | null {
  if (!value) return null;
  const v = value.trim();
  // ISO date or datetime
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})([T\s](\d{2}):(\d{2})(:(\d{2}))?)?$/);
  if (m) {
    const [, y, mo, d, , hh = "00", mm = "00", , ss = "00"] = m;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss));
    // Reject rollover corruption: Date.UTC silently wraps month 13 / day 32.
    if (
      !isNaN(dt.getTime()) &&
      +mo >= 1 &&
      +mo <= 12 &&
      +d >= 1 &&
      +d <= 31 &&
      dt.getUTCDate() === +d &&
      dt.getUTCMonth() === +mo - 1
    ) {
      return dt;
    }
  }
  // DD/MM/YYYY or DD-MM-YYYY (slash dates)
  const m2 = v.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m2) {
    const [, a, b, y] = m2;
    let day = +a;
    let month = +b;
    // Bug fix: "12/25/2025" — month-first input where the second component
    // cannot be a month. Swap instead of silently rolling over into March.
    if (month > 12 && day <= 12) {
      const t = day;
      day = month;
      month = t;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const dt = new Date(Date.UTC(+y, month - 1, day));
    if (!isNaN(dt.getTime()) && dt.getUTCDate() === day && dt.getUTCMonth() === month - 1) {
      return dt;
    }
    return null;
  }
  return null;
}

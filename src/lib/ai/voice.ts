/**
 * Phase 18 — VOICE ORDER SUPPORT (server-side text parsing for the client
 * Web Speech API transcript).
 *
 * ARCHITECTURE (privacy-first):
 *  - Speech recognition happens CLIENT-SIDE (browser Web Speech API) with an
 *    explicit microphone permission. RAW AUDIO NEVER LEAVES THE DEVICE and
 *    never enters logs, reports or AI context — only the recognized TEXT
 *    transcript is processed.
 *  - The server's job: turn a transcript like "add two masala dosa and one
 *    paneer tikka" into a cart proposal. The proposal is ALWAYS rendered for
 *    explicit human confirmation before submission — voice can never place
 *    an order by itself, never trigger a payment, and never silently edit
 *    the cart.
 *  - Number words (EN + HI romanized) are normalized deterministically.
 *  - Everything is rule-based and tenant-catalog-scoped: unknown items are
 *    flagged UNRECOGNIZED, never guessed.
 *  - Client fallback: a text field mirrors the same parse endpoint — the
 *    flow is fully usable without a microphone (accessibility requirement).
 */

import { db } from "@/lib/db";

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  ek: 1, do: 2, teen: 3, char: 4, paanch: 5, panch: 5, chah: 6, saat: 7, aath: 8, nau: 9, das: 10,
};

export interface VoiceCartLine {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
  confidence: "EXACT" | "PARTIAL" | "UNRECOGNIZED";
}

export interface VoiceParseResult {
  ok: boolean;
  lines: VoiceCartLine[];
  unrecognized: string[];
  needsConfirmation: true; // ALWAYS — voice never submits directly
}

export interface VoiceCatalogItem {
  id: string;
  name: string;
  priceMinor: number;
  available: boolean;
}

/** Load the tenant catalog for voice parsing (active + available only). */
export async function loadVoiceCatalog(hotelId: string): Promise<VoiceCatalogItem[]> {
  return db.menuItem.findMany({
    where: { hotelId, active: true, available: true },
    select: { id: true, name: true, priceMinor: true, available: true },
    orderBy: { sortOrder: "asc" },
    take: 500,
  });
}

/**
 * Parse a transcript against the tenant catalog. Deterministic and
 * catalog-scoped: no invented items, no invented prices.
 */
export function parseVoiceTranscript(
  transcript: string,
  catalog: VoiceCatalogItem[],
): VoiceParseResult {
  const lines: VoiceCartLine[] = [];
  const unrecognized: string[] = [];

  // Split on "and"/"aur"/commas — deterministic chunking.
  const chunks = String(transcript || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+(?:and|aur|then|phir)\s+|,/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 12); // sanity cap

  for (const chunk of chunks) {
    // Leading quantity: digit or number-word.
    let qty = 1;
    const m = chunk.match(/^(\d{1,2})\s+(.*)$/) ?? chunk.match(/^(ek|do|teen|char|paanch|panch|chah|saat|aath|nau|das|one|two|three|four|five|six|seven|eight|nine|ten)\s+(.*)$/);
    if (m) {
      const q = NUMBER_WORDS[m[1]] ?? Number(m[1]);
      if (Number.isInteger(q) && q >= 1 && q <= 20) {
        qty = q;
      }
    }
    const namePart = (m ? (m[2] ?? m[3] ?? "") : chunk)
      .replace(/^(add|order|lena hai|chahiye)\s+/i, "")
      .replace(/\b(please|kripya)\b/gi, "")
      .trim();

    if (!namePart) continue;

    const item = matchVoiceItem(catalog, namePart);
    if (!item) {
      unrecognized.push(namePart.slice(0, 60));
      continue;
    }
    const existing = lines.find((l) => l.menuItemId === item.id);
    if (existing) existing.quantity = Math.min(50, existing.quantity + qty);
    else {
      lines.push({
        menuItemId: item.id, name: item.name, quantity: qty,
        unitPriceMinor: item.priceMinor, confidence: "PARTIAL",
      });
    }
  }

  return { ok: lines.length > 0, lines, unrecognized, needsConfirmation: true };
}

function matchVoiceItem(catalog: VoiceCatalogItem[], text: string): VoiceCatalogItem | null {
  const t = text.toLowerCase().trim();
  if (!t) return null;
  // Strip common filler trailing words ("do ek" handled by qty; trailing "dena/hai" etc.)
  const cleaned = t.replace(/\b(dena|do mujhe|karna hai|hai)\b/gi, "").trim();
  const exact = catalog.find((i) => i.name.toLowerCase() === cleaned);
  if (exact) return exact;
  const prefix = catalog.find((i) => i.name.toLowerCase().startsWith(cleaned));
  if (prefix) return prefix;
  return catalog.find((i) => i.name.toLowerCase().includes(cleaned)) ?? null;
}

/** Total of the proposed voice cart (display only — server re-prices at submit). */
export function voiceCartTotal(lines: VoiceCartLine[]): number {
  return lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
}

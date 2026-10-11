import { db } from "@/lib/db";

/**
 * Message templates — Phase 6.3
 *
 * Nine ready-to-use campaign templates per hotel (spec §20). Templates use the
 * existing {{variable}} personalization engine (src/lib/personalize.ts), so
 * unknown variables are sanitized at send time and injection is impossible.
 * Every variable in a default body is part of the supported set.
 */

export interface DefaultTemplate {
  name: string;
  category:
    | "WELCOME"
    | "THANK_YOU"
    | "COME_BACK"
    | "BIRTHDAY"
    | "SPECIAL_OFFER"
    | "FESTIVAL_OFFER"
    | "LOYALTY_REWARD"
    | "INACTIVE_WINBACK"
    | "VIP_APPRECIATION";
  body: string;
  channels: string; // JSON array
}

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  {
    name: "Welcome",
    category: "WELCOME",
    body: "Welcome to the {{hotel_name}} family, {{name}}! 🎉 Thank you for joining. Keep an eye out for member-only offers coming your way.",
    channels: JSON.stringify(["WHATSAPP"]),
  },
  {
    name: "Thank You",
    category: "THANK_YOU",
    body: "Hi {{name}}, thank you for dining at {{hotel_name}}! We hope you enjoyed your visit and look forward to seeing you again soon. 🙏",
    channels: JSON.stringify(["WHATSAPP"]),
  },
  {
    name: "Come Back",
    category: "COME_BACK",
    body: "Hi {{name}}, it's been a while since your last visit to {{hotel_name}} ({{last_visit}}). Come back soon — we'd love to serve you again!",
    channels: JSON.stringify(["WHATSAPP", "SMS"]),
  },
  {
    name: "Birthday Wish",
    category: "BIRTHDAY",
    body: "Happy Birthday, {{name}}! 🎂 All of us at {{hotel_name}} wish you a wonderful day. Show this message to enjoy a special birthday treat on us!",
    channels: JSON.stringify(["WHATSAPP"]),
  },
  {
    name: "Special Offer",
    category: "SPECIAL_OFFER",
    body: "Hi {{name}}, here's an exclusive offer from {{hotel_name}}: {{offer}}. Visit us and mention this message to avail it!",
    channels: JSON.stringify(["WHATSAPP", "SMS"]),
  },
  {
    name: "Festival Offer",
    category: "FESTIVAL_OFFER",
    body: "Festive greetings from {{hotel_name}}! 🪔 Celebrate with {{offer}} — valid for a limited time. We look forward to welcoming you!",
    channels: JSON.stringify(["WHATSAPP", "SMS"]),
  },
  {
    name: "Loyalty Reward",
    category: "LOYALTY_REWARD",
    body: "Great news {{name}}! You've unlocked a loyalty reward at {{hotel_name}}: {{offer}}. Thank you for being one of our most valued guests. ⭐",
    channels: JSON.stringify(["WHATSAPP"]),
  },
  {
    name: "Inactive Win-back",
    category: "INACTIVE_WINBACK",
    body: "Hi {{name}}, we miss you at {{hotel_name}}! It's been {{last_visit}} since we saw you last. Here's {{offer}} to welcome you back. 😊",
    channels: JSON.stringify(["WHATSAPP", "SMS"]),
  },
  {
    name: "VIP Appreciation",
    category: "VIP_APPRECIATION",
    body: "Dear {{name}}, as one of our most valued guests at {{hotel_name}}, you deserve the very best. Enjoy {{offer}} — with our compliments. 💐",
    channels: JSON.stringify(["WHATSAPP"]),
  },
];

/** Create the 9 default templates for a hotel if none exist yet. Idempotent. */
export async function ensureDefaultTemplates(hotelId: string): Promise<void> {
  const count = await db.messageTemplate.count({ where: { hotelId } });
  if (count > 0) return;
  await db.messageTemplate.createMany({
    data: DEFAULT_TEMPLATES.map((t) => ({
      hotelId,
      name: t.name,
      category: t.category,
      body: t.body,
      channels: t.channels,
      isDefault: true,
    })),
  });
}

const VALID_CATEGORIES = DEFAULT_TEMPLATES.map((t) => t.category);
const VALID_CHANNELS = ["WHATSAPP", "SMS", "EMAIL"];

export function normalizeChannels(raw: unknown): string[] {
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return ["WHATSAPP"];
    const filtered = arr.filter(
      (c): c is string => typeof c === "string" && VALID_CHANNELS.includes(c),
    );
    return filtered.length ? Array.from(new Set(filtered)) : ["WHATSAPP"];
  } catch {
    return ["WHATSAPP"];
  }
}

export function isTemplateCategory(value: string): value is (typeof VALID_CATEGORIES)[number] {
  return (VALID_CATEGORIES as string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* RECHECK FIX (D) — WhatsApp provider binding helpers                 */
/* ------------------------------------------------------------------ */

/**
 * A template becomes a REAL WhatsApp deliverable only when it carries the
 * provider-side binding: the APPROVED template name (providerTemplateId),
 * its approved language, and a positional variableMap ("1"→"name",
 * "2"→"offer", …) that maps our {{placeholders}} to Meta's positional body
 * parameters. Approval status is tracked honestly (DRAFT → PENDING →
 * APPROVED/REJECTED/PAUSED) — the send pipeline refuses anything but
 * APPROVED, so the lifecycle must be explicit instead of implying that a
 * saved local text is automatically WhatsApp-approved.
 */
export const TEMPLATE_APPROVAL_STATUSES = [
  "DRAFT",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "PAUSED",
] as const;

const TEMPLATE_ALLOWED_PLACEHOLDERS = new Set([
  "name",
  "hotel_name",
  "last_visit",
  "booking_count",
  "offer",
  "booking_link",
]);

export function parseTemplateBinding(body: Record<string, unknown>): {
  providerTemplateId?: string | null;
  languageCode?: string | null;
  variableMap?: string | null;
  approvalStatus?: string | null;
  error?: string;
} {
  const out: {
    providerTemplateId?: string | null;
    languageCode?: string | null;
    variableMap?: string | null;
    approvalStatus?: string | null;
    error?: string;
  } = {};

  if (body.providerTemplateId !== undefined) {
    const v = typeof body.providerTemplateId === "string" ? body.providerTemplateId.trim() : "";
    if (v && !/^[a-z0-9_]{2,64}$/i.test(v)) {
      return {
        error: "Provider template name must be 2–64 characters (letters, numbers, underscores).",
      };
    }
    out.providerTemplateId = v || null;
  }
  if (body.languageCode !== undefined) {
    const v = typeof body.languageCode === "string" ? body.languageCode.trim() : "";
    if (v && !/^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/.test(v)) {
      return { error: "Language code must be BCP-47, e.g. en, en_US or hi." };
    }
    out.languageCode = v || null;
  }
  if (body.variableMap !== undefined) {
    if (body.variableMap === null) {
      out.variableMap = null;
    } else if (typeof body.variableMap === "object" && !Array.isArray(body.variableMap)) {
      const map = body.variableMap as Record<string, unknown>;
      const cleaned: Record<string, string> = {};
      for (const [position, placeholder] of Object.entries(map)) {
        if (!/^([1-9]|10)$/.test(position)) {
          return { error: `Invalid template variable position "${position}" — use 1–10.` };
        }
        if (typeof placeholder !== "string" || !TEMPLATE_ALLOWED_PLACEHOLDERS.has(placeholder)) {
          return {
            error: `Unknown placeholder "${String(placeholder)}" — allowed: ${[...TEMPLATE_ALLOWED_PLACEHOLDERS].join(", ")}.`,
          };
        }
        cleaned[position] = placeholder;
      }
      out.variableMap = JSON.stringify(cleaned);
    } else {
      return { error: 'variableMap must be an object like { "1": "name", "2": "offer" }.' };
    }
  }
  if (body.approvalStatus !== undefined) {
    const v =
      typeof body.approvalStatus === "string" ? body.approvalStatus.trim().toUpperCase() : "";
    if (v && !(TEMPLATE_APPROVAL_STATUSES as readonly string[]).includes(v)) {
      return { error: `Approval status must be one of: ${TEMPLATE_APPROVAL_STATUSES.join(", ")}.` };
    }
    out.approvalStatus = v || null;
  }
  return out;
}

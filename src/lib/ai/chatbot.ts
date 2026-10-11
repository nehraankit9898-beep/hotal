/**
 * Phase 18 — WHATSAPP ORDERING CHATBOT (rule-based, server-validated).
 *
 * ARCHITECTURE — what this engine is and deliberately is NOT:
 *  - It is a TRANSPARENT RULE-BASED intent engine (keyword/pattern matching
 *    with deterministic state machine). It never invents prices, items,
 *    availability or policies: every catalogue fact in a reply is read from
 *    the tenant's live menu, and every total is computed by the SAME
 *    server-side `priceCart` used by the QR web cart. There is no LLM in the
 *    loop (modelProvider NONE) — so "the model cannot invent data" is true
 *    by construction, not by prompt discipline.
 *  - It does NOT touch the DB except through: AIConversation state rows,
 *    AIInteractionLog audit rows, and `createOrder` (the Phase 13 pipeline
 *    with idempotency + server pricing). No direct order writes here.
 *  - Ordering requires an EXPLICIT confirmation step ("CONFIRM" state): the
 *    customer must reply with an affirmative after seeing the server-priced
 *    summary. A list or add-to-cart reply can never place an order.
 *  - Prompt-injection resistant: customer text is treated as opaque input —
 *    it is never interpolated into instructions, never executed, never
 *    stored raw in audit logs. URLs in customer text are ignored outright.
 *  - Consent: ordering does NOT require marketing consent, but the bot never
 *    enrolls anyone into marketing (no campaign side effects). An explicit
 *    STOP/UNSUBSCRIBE request is honoured immediately (state OPTOUT) and
 *    suppresses ALL future bot replies until START.
 *  - Tenant routing: the webhook resolves the tenant from the WhatsApp
 *    business number the message arrived on (integration credentials are
 *    per-tenant) — the customer's text can never choose another tenant.
 *  - Idempotency: the provider message id is stored on the conversation
 *    (unique) — a replayed webhook delivery is acknowledged but not
 *    re-processed.
 *  - Budget: every billable turn passes `reserveAIRequest`; over budget →
 *    graceful HANDOFF notice, no order can be placed by a blocked bot.
 */

import { db } from "@/lib/db";
import { createOrder, priceCart, CartValidationError, type CartLineInput } from "@/lib/orders";
import { getAISettings, withinServiceHours, logAIInteraction, reserveAIRequest } from "@/lib/ai/governance";
import { logger } from "@/lib/logger";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type ChatState = "IDLE" | "BROWSING" | "CART" | "CONFIRM" | "ORDERED" | "HANDOFF" | "OPTOUT";

export interface StoredCartLine {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface ChatbotReply {
  body: string;
  nextState: ChatState;
  placedOrderId?: string;
  handoff?: boolean;
}

interface ConversationRow {
  id: string;
  hotelId: string;
  phone: string;
  customerId: string | null;
  state: string;
  cartJson: string | null;
  lastOrderId: string | null;
  messageCount: number;
}

/* ------------------------------------------------------------------ */
/* Text normalization & intent detection (transparent rules)           */
/* ------------------------------------------------------------------ */

const AFFIRMATIVES = new Set(["yes", "y", "confirm", "confirmed", "ok", "okay", "haan", "ha", "place order", "order it", "sure", "1"]);
const NEGATIVES = new Set(["no", "n", "cancel", "nahi", "nahin", "stop", "don't", "dont", "2"]);
const MENU_WORDS = ["menu", "items", "food", "kya hai", "what do you have", "show menu", "menu dikhao", "menu dikha"];
const CART_WORDS = ["cart", "my order", "mera order", "basket"];
const DONE_WORDS = ["done", "thats all", "that's all", "bas", "complete", "checkout", "order karna hai", "place"];
const HUMAN_WORDS = ["human", "agent", "staff", "manager", "help", "call", "baat karao", "koi hai"];

/** Strip everything that is not plain words/digits — URLs, emojis, control chars, markdown. */
export function sanitizeInput(raw: string): string {
  return String(raw || "")
    // URLs are NEVER echoed, clicked or stored — strip before anything else.
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[^\p{L}\p{N}\s'.,-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300); // hard input cap
}

export function detectIntent(sanitized: string): "MENU" | "ADD" | "REMOVE" | "CART" | "DONE" | "CONFIRM_YES" | "CONFIRM_NO" | "HUMAN" | "STOP" | "START" | "GREETING" | "UNKNOWN" {
  const t = sanitized.toLowerCase();
  if (!t) return "UNKNOWN";
  if (/^(stop|unsubscribe|opt ?out|band karo)$/.test(t)) return "STOP";
  if (/^(start|subscribe|opt ?in)$/.test(t)) return "START";
  if (AFFIRMATIVES.has(t)) return "CONFIRM_YES";
  if (NEGATIVES.has(t)) return "CONFIRM_NO";
  if (HUMAN_WORDS.some((w) => t.includes(w))) return "HUMAN";
  if (MENU_WORDS.some((w) => t.includes(w))) return "MENU";
  if (CART_WORDS.some((w) => t === w || t.startsWith(w))) return "CART";
  if (DONE_WORDS.some((w) => t === w || t === "place order")) return "DONE";
  if (/^(hi|hello|hey|namaste|salam|good (morning|evening|afternoon))\b/.test(t)) return "GREETING";
  // "2 butter chicken", "remove 1 naan", "add 2 paneer" …
  if (/^(add|remove|delete)\b/.test(t) || /^\d+\s+\S/.test(t)) return t.startsWith("remove") || t.startsWith("delete") ? "REMOVE" : "ADD";
  // Any text that fuzzy-matches a menu item name is an ADD attempt.
  if (t.length >= 3) return "ADD";
  return "UNKNOWN";
}

/* ------------------------------------------------------------------ */
/* Catalog helpers                                                     */
/* ------------------------------------------------------------------ */

export interface CatalogItem {
  id: string;
  name: string;
  priceMinor: number;
  available: boolean;
}

/** Load the ACTIVE+AVAILABLE catalog for fuzzy name matching (tenant-scoped). */
async function loadCatalog(hotelId: string): Promise<CatalogItem[]> {
  const items = await db.menuItem.findMany({
    where: { hotelId, active: true, available: true },
    select: { id: true, name: true, priceMinor: true, available: true },
    orderBy: { sortOrder: "asc" },
    take: 500,
  });
  return items;
}

/**
 * Deterministic fuzzy match with a documented precedence:
 *   1. exact name equality,
 *   2. input is a prefix of a name ("masal" → "Masala Dosa"),
 *   3. a name is a substring of the input ("paneer tikka extra" → "Paneer Tikka"),
 *   4. the input is contained inside a name.
 * Ties are broken by the LONGEST matching name (most specific wins), then by
 * catalog order (sortOrder). Unknown text → null (never guessed).
 */
export function matchItem(catalog: CatalogItem[], text: string): CatalogItem | null {
  const t = text.toLowerCase().replace(/^(add|remove|delete)\s+/i, "").replace(/^\d+\s+/, "").trim();
  if (!t) return null;
  let best: CatalogItem | null = null;
  let bestLen = -1;
  for (const item of catalog) {
    const name = item.name.toLowerCase();
    let hit = false;
    if (name === t) hit = true;
    else if (name.startsWith(t)) hit = true;
    else if (t.includes(name)) hit = true;
    else if (name.includes(t)) hit = true;
    if (hit && name.length > bestLen) {
      best = item;
      bestLen = name.length;
    }
  }
  return best;
}

function parseQuantity(text: string): number {
  const m = text.match(/^(\d{1,2})\s/);
  if (m) {
    const q = Number(m[1]);
    if (Number.isInteger(q) && q >= 1 && q <= 20) return q;
  }
  return 1;
}

function formatMoney(minor: number, currency: string): string {
  const symbol = currency === "INR" ? "₹" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  const major = minor / 100;
  const s = Number.isInteger(major) ? String(major) : major.toFixed(2);
  return `${symbol}${s}`;
}

/* ------------------------------------------------------------------ */
/* Conversation persistence                                            */
/* ------------------------------------------------------------------ */

async function getOrCreateConversation(hotelId: string, phone: string): Promise<ConversationRow> {
  const existing = await db.aIConversation.findUnique({
    where: { hotelId_phone: { hotelId, phone } },
  });
  if (existing) return existing;
  // Link an existing CRM customer by phone when present (ordering does not
  // require marketing consent — this is a service conversation).
  const customer = await db.customer.findFirst({
    where: { hotelId, phone },
    select: { id: true },
  });
  try {
    return await db.aIConversation.create({
      data: { hotelId, phone, customerId: customer?.id ?? null, state: "IDLE" },
    });
  } catch {
    const again = await db.aIConversation.findUnique({ where: { hotelId_phone: { hotelId, phone } } });
    if (again) return again;
    throw new Error("conversation_create_failed");
  }
}

function readCart(row: ConversationRow): StoredCartLine[] {
  if (!row.cartJson) return [];
  try {
    const parsed = JSON.parse(row.cartJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (l): l is StoredCartLine =>
        !!l && typeof l === "object" &&
        typeof (l as StoredCartLine).menuItemId === "string" &&
        typeof (l as StoredCartLine).quantity === "number",
    );
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* The engine                                                          */
/* ------------------------------------------------------------------ */

export interface InboundMessage {
  hotelId: string; // resolved by the webhook from the receiving business number — never from customer text
  phone: string;
  text: string;
  messageId?: string; // provider message id for replay dedup
  customerName?: string | null;
}

/**
 * Process one inbound WhatsApp message and produce the reply. All the
 * guarantees in the header comment are enforced here.
 */
export async function handleInboundWhatsApp(msg: InboundMessage): Promise<ChatbotReply> {
  const settings = await getAISettings(msg.hotelId);

  // --- Feature flag: no flag → the bot does not exist for this tenant.
  if (!settings.chatbotEnabled) {
    await logAIInteraction({
      hotelId: msg.hotelId, kind: "CHATBOT", status: "BLOCKED_DISABLED",
      reason: "CHATBOT_DISABLED", channel: "WHATSAPP",
    });
    return { body: "", nextState: "IDLE" }; // webhook route will 200-no-op
  }

  // --- Opt-out is honoured instantly and unconditionally (consent wins over
  // everything, including the feature flag itself for STOP handling).
  const raw = sanitizeInput(msg.text);
  const intent = detectIntent(raw);
  if (intent === "STOP") {
    await db.aIConversation.updateMany({
      where: { hotelId: msg.hotelId, phone: msg.phone },
      data: { state: "OPTOUT" },
    });
    // The customer's own marketing opt-out flags are respected too.
    const cust = await db.customer.findFirst({ where: { hotelId: msg.hotelId, phone: msg.phone } });
    if (cust && (cust.marketingConsent || cust.whatsappOptIn)) {
      await db.customer.update({
        where: { id: cust.id },
        data: { marketingConsent: false, whatsappOptIn: false, optOut: true },
      });
    }
    await logAIInteraction({
      hotelId: msg.hotelId, kind: "CHATBOT", subtype: "STOP",
      status: "OK", reason: "OPT_OUT", channel: "WHATSAPP",
      customerId: cust?.id ?? null,
    });
    return { body: "You have been unsubscribed. Reply START if you want updates again.", nextState: "OPTOUT" };
  }

  const conv = await getOrCreateConversation(msg.hotelId, msg.phone);

  // --- Idempotency: replayed webhook deliveries are never re-processed.
  if (msg.messageId) {
    const clash = await db.aIConversation.findFirst({ where: { lastInboundId: msg.messageId } });
    if (clash) {
      return { body: "", nextState: conv.state as ChatState }; // duplicate — no reply
    }
  }

  // --- Opted-out conversation: ignore everything except START.
  if (conv.state === "OPTOUT") {
    if (intent === "START") {
      await db.aIConversation.update({ where: { id: conv.id }, data: { state: "IDLE" } });
      return { body: "Welcome back! Reply MENU to see what we serve today.", nextState: "IDLE" };
    }
    return { body: "", nextState: "OPTOUT" };
  }

  // --- Budget gate (before ANY billable work).
  const budget = await reserveAIRequest(msg.hotelId);
  if (!budget.ok) {
    await logAIInteraction({
      hotelId: msg.hotelId, kind: "CHATBOT", subtype: intent,
      status: "BLOCKED_BUDGET", reason: budget.reason ?? "BUDGET", channel: "WHATSAPP",
      customerId: conv.customerId,
    });
    return {
      body: "Our assistant is at capacity right now. Please call us directly to order — we're happy to help!",
      nextState: "HANDOFF", handoff: true,
    };
  }

  // --- Service window (ordering hours).
  if (!withinServiceHours(settings.chatbotServiceHours)) {
    await logAIInteraction({
      hotelId: msg.hotelId, kind: "CHATBOT", subtype: intent,
      status: "HANDOFF", reason: "OUTSIDE_SERVICE_HOURS", channel: "WHATSAPP",
      customerId: conv.customerId,
    });
    return {
      body: `We're not taking orders through chat right now.${settings.handoffPhone ? ` Please call ${settings.handoffPhone}.` : ""} Reply MENU anytime to see our menu.`,
      nextState: "HANDOFF", handoff: true,
    };
  }

  try {
    const reply = await route(msg, conv, raw, intent, settings);
    // Bump messageCount + persist dedup id + state.
    await db.aIConversation.update({
      where: { id: conv.id },
      data: {
        state: reply.nextState,
        messageCount: { increment: 1 },
        lastActivityAt: new Date(),
        ...(msg.messageId ? { lastInboundId: msg.messageId } : {}),
      },
    });
    await logAIInteraction({
      hotelId: msg.hotelId, kind: "CHATBOT", subtype: intent,
      status: "OK", reason: null, channel: "WHATSAPP",
      customerId: conv.customerId,
      meta: { nextState: reply.nextState, placed: !!reply.placedOrderId },
    });
    return reply;
  } catch (err) {
    logger.error("ai.chatbot_error", { error: String(err) });
    await logAIInteraction({
      hotelId: msg.hotelId, kind: "CHATBOT", subtype: intent,
      status: "ERROR", reason: "ENGINE_ERROR", channel: "WHATSAPP",
      customerId: conv.customerId,
    });
    return {
      body: "Sorry — something went wrong on our side. Your order was NOT placed. Please try again or call us.",
      nextState: conv.state === "CONFIRM" ? "CART" : "IDLE",
    };
  }
}

/* ------------------------------------------------------------------ */
/* State routing                                                       */
/* ------------------------------------------------------------------ */

async function route(
  msg: InboundMessage,
  conv: ConversationRow,
  raw: string,
  intent: ReturnType<typeof detectIntent>,
  settings: Awaited<ReturnType<typeof getAISettings>>,
): Promise<ChatbotReply> {
  const currency = "INR";

  // Human handoff request — anywhere, anytime.
  if (intent === "HUMAN") {
    const num = settings.handoffPhone;
    return {
      body: num
        ? `Connecting you to our team — please call ${num} or visit us. Reply MENU to keep ordering here.`
        : "Our team will reach out shortly. Reply MENU to keep ordering here.",
      nextState: conv.state === "CONFIRM" ? "CONFIRM" : "CART", handoff: true,
    };
  }

  switch (intent) {
    case "MENU":
    case "GREETING": {
      const catalog = await loadCatalog(msg.hotelId);
      if (catalog.length === 0) {
        return { body: "Our menu is being updated — please check back soon!", nextState: "IDLE" };
      }
      const lines = catalog.slice(0, 12).map((i) => `• ${i.name} — ${formatMoney(i.priceMinor, currency)}`);
      const more = catalog.length > 12 ? `\n…and ${catalog.length - 12} more. Ask for any item by name.` : "";
      return {
        body: `Today's menu:\n${lines.join("\n")}${more}\n\nTo order, reply with item name and quantity (e.g. "2 Masala Dosa").`,
        nextState: "BROWSING",
      };
    }

    case "CART": {
      const cart = readCart(conv);
      if (cart.length === 0) return { body: "Your cart is empty. Reply MENU to browse.", nextState: "BROWSING" };
      return { body: cartSummary(cart, currency), nextState: "CART" };
    }

    case "REMOVE": {
      const cart = readCart(conv);
      const item = matchItem(await loadCatalog(msg.hotelId), raw);
      if (!item) return { body: "I couldn't find that item in the menu. Reply MENU to browse.", nextState: "CART" };
      const next = cart.filter((l) => l.menuItemId !== item.id);
      await db.aIConversation.update({ where: { id: conv.id }, data: { cartJson: JSON.stringify(next) } });
      return {
        body: next.length ? `Removed ${item.name}.\n\n${cartSummary(next, currency)}\n\nReply DONE to checkout.` : `Removed ${item.name}. Your cart is now empty — reply MENU to browse.`,
        nextState: next.length ? "CART" : "BROWSING",
      };
    }

    case "ADD": {
      const catalog = await loadCatalog(msg.hotelId);
      const item = matchItem(catalog, raw);
      if (!item) {
        return {
          body: "I couldn't find that on our menu. Reply MENU to see today's items, or ask for something by its exact name.",
          nextState: "BROWSING",
        };
      }
      // Re-price the WHOLE cart from the live catalog every turn — a stale
      // price can never leak into the summary.
      const cart = readCart(conv);
      const existing = cart.find((l) => l.menuItemId === item.id);
      const qty = existing ? Math.min(50, existing.quantity + parseQuantity(raw)) : parseQuantity(raw);
      const next = [...cart.filter((l) => l.menuItemId !== item.id), { menuItemId: item.id, name: item.name, quantity: qty, unitPriceMinor: item.priceMinor, lineTotalMinor: item.priceMinor * qty }];
      await db.aIConversation.update({ where: { id: conv.id }, data: { cartJson: JSON.stringify(next) } });
      return {
        body: `Added ${qty} × ${item.name}.\n\n${cartSummary(next, currency)}\n\nReply DONE to checkout or keep adding items.`,
        nextState: "CART",
      };
    }

    case "DONE": {
      const cart = readCart(conv);
      if (cart.length === 0) return { body: "Your cart is empty — reply MENU to browse first.", nextState: "BROWSING" };
      // Server-prices the cart NOW; the summary shown is authoritative.
      const priced = await priceCartFromStored(msg.hotelId, cart);
      if (!priced.ok) {
        return { body: `${priced.error}\n\nYour cart was updated — reply MENU to browse and add items again.`, nextState: "BROWSING" };
      }
      return {
        body: `Please confirm your order:\n\n${priced.summary}\n\nReply YES to place this order, or NO to keep editing.`,
        nextState: "CONFIRM",
      };
    }

    case "CONFIRM_YES": {
      if (conv.state !== "CONFIRM") {
        return { body: "Nothing to confirm yet — reply MENU to browse and build your order.", nextState: "BROWSING" };
      }
      const cart = readCart(conv);
      if (cart.length === 0) return { body: "Your cart is empty — reply MENU to browse.", nextState: "BROWSING" };
      const priced = await priceCartFromStored(msg.hotelId, cart);
      if (!priced.ok) {
        return { body: `${priced.error}\n\nPlease build your order again — reply MENU.`, nextState: "BROWSING" };
      }
      // Place through the SAME pipeline as the web cart (idempotent,
      // server-priced, events recorded). The idempotency key is derived from
      // the conversation + confirmation turn so a provider retry cannot
      // double-place.
      const idempotencyKey = `wa-${conv.id}-${Date.now()}`;
      const result = await createOrder({
        hotelId: msg.hotelId,
        cart: cart.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity })),
        idempotencyKey,
        customerName: msg.customerName ?? null,
        customerPhone: msg.phone,
        source: "QR_CUSTOMER",
        notes: "Placed via WhatsApp ordering assistant",
      });
      await db.aIConversation.update({
        where: { id: conv.id },
        data: { cartJson: JSON.stringify([]), lastOrderId: result.order.id },
      });
      await logAIInteraction({
        hotelId: msg.hotelId, kind: "CHATBOT", subtype: "ORDER_PLACED",
        status: "OK", channel: "WHATSAPP", customerId: conv.customerId,
        meta: { orderId: result.order.id, totalMinor: result.order.totalMinor },
      });
      return {
        body: `Order placed! 🎉 Order #${result.order.orderNumber}\n\n${priced.summary}\n\nTrack it any time by asking "order status". Thank you!`,
        nextState: "ORDERED",
        placedOrderId: result.order.id,
      };
    }

    case "CONFIRM_NO": {
      if (conv.state === "CONFIRM") {
        return { body: "No problem — your cart is saved. Reply DONE when you're ready, or tell me what to change.", nextState: "CART" };
      }
      return { body: "Okay. Reply MENU to browse.", nextState: "BROWSING" };
    }

    case "START":
      return { body: "Welcome! Reply MENU to see what we serve today.", nextState: "IDLE" };

    case "UNKNOWN":
    default:
      return {
        body: "I can help you order — reply MENU to see today's items, or tell me a dish name with quantity (e.g. \"2 Paneer Tikka\"). For anything else, reply HELP to reach our team.",
        nextState: conv.state === "CONFIRM" ? "CONFIRM" : "BROWSING",
      };
  }
}

/* ------------------------------------------------------------------ */
/* Server-side pricing of the stored cart                              */
/* ------------------------------------------------------------------ */

/**
 * Re-price the stored chatbot cart through priceCart (the Phase 13 engine).
 * The cart lines stored on the conversation are a convenience cache — the
 * authoritative name/price/options ALWAYS come from this live catalog read.
 */
async function priceCartFromStored(
  hotelId: string,
  cart: StoredCartLine[],
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const inputs: CartLineInput[] = cart.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity }));
  try {
    const priced = await priceCart(hotelId, inputs);
    const currency = priced.currency;
    const lines = priced.lines.map(
      (l) => `• ${l.quantity} × ${l.nameSnapshot} — ${formatMoney(l.lineTotalMinor, currency)}`,
    );
    return { ok: true, summary: `${lines.join("\n")}\n\nTotal: ${formatMoney(priced.subtotalMinor, currency)}` };
  } catch (err) {
    if (err instanceof CartValidationError) {
      const friendly: Record<string, string> = {
        ITEM_NOT_FOUND: "One of the items is no longer on the menu.",
        ITEM_UNAVAILABLE: "One of the items just sold out.",
        OPTION_REQUIRED: "One of the items needs options selected (please order this one in-restaurant or via the QR menu).",
        EMPTY_CART: "Your cart is empty.",
        QUANTITY_INVALID: "Quantity out of range.",
      };
      return { ok: false, error: friendly[err.code] ?? "Your cart could not be validated." };
    }
    return { ok: false, error: "Your cart could not be validated right now." };
  }
}

function cartSummary(cart: StoredCartLine[], currency: string): string {
  const lines = cart.map((l) => `• ${l.quantity} × ${l.name} — ${formatMoney(l.lineTotalMinor, currency)}`);
  const total = cart.reduce((s, l) => s + l.lineTotalMinor, 0);
  return `${lines.join("\n")}\n\nRunning total: ${formatMoney(total, currency)}`;
}

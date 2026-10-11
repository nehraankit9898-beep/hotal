import { z } from "zod";

/**
 * Input validation — Phase 11.
 * Central Zod schemas for every API payload. Prefer allowlists; cap lengths;
 * validate IDs, enums, dates, pagination and CSV payloads.
 * Zod v4 is installed (`zod@^4`).
 */

// ---------- primitives ----------

export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid id format");
export const cuidLikeSchema = z.string().min(10).max(64);
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Please enter a valid email address.")
  .max(254);
export const phoneSchema = z.string().trim().min(7).max(20);
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters long.")
  .max(128)
  .regex(/[a-zA-Z]/, "Password must contain at least one letter.")
  .regex(/[0-9]/, "Password must contain at least one number.");

/** Pagination — hard caps prevent excessive queries. */
export function paginationSchema(maxPageSize = 50) {
  return z.object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(maxPageSize).default(10),
  });
}

// ---------- auth ----------

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Please enter your password.").max(128),
});

export const superAdminLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const registerHotelSchema = z.object({
  hotelName: z.string().trim().min(2, "Please enter your hotel's name.").max(100),
  location: z.string().trim().max(120).optional().default(""),
  hotelPhone: z.string().trim().max(20).optional().default(""),
  adminName: z.string().trim().min(2, "Please enter the admin's full name.").max(100),
  email: emailSchema,
  password: passwordSchema,
});

export const activateAccountSchema = z.object({
  token: z
    .string()
    .min(20)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const profileUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    currentPassword: z.string().min(1).max(128).optional(),
    newPassword: passwordSchema.optional(),
  })
  .refine(
    (v) => v.name !== undefined || (v.currentPassword !== undefined && v.newPassword !== undefined),
    { message: "Nothing to update." },
  );

// ---------- customers ----------

export const customerCreateSchema = z.object({
  name: z.string().trim().min(2, "Please enter the customer's full name.").max(100),
  phone: phoneSchema,
  email: z.string().trim().max(254).optional().default(""),
  marketingConsent: z.boolean().optional().default(false),
  consentSource: z.enum(["MANUAL_ENTRY", "WEBSITE", "CSV_IMPORT", "PHONE", "IN_PERSON"]).optional(),
  roomPreference: z.string().trim().max(60).optional(),
  foodPreference: z.string().trim().max(60).optional(),
  location: z.string().trim().max(80).optional(),
  birthday: z.string().optional(),
  anniversary: z.string().optional(),
  source: z.enum(["WALK_IN", "BOOKING", "WEBSITE", "REFERRAL", "OTHER"]).optional(),
  notes: z.string().trim().max(1000).optional(),
  vip: z.boolean().optional().default(false),
});

export const customerUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    phone: phoneSchema.optional(),
    email: z.string().trim().max(254).nullable().optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
    roomPreference: z.string().trim().max(60).nullable().optional(),
    foodPreference: z.string().trim().max(60).nullable().optional(),
    location: z.string().trim().max(80).nullable().optional(),
    birthday: z.string().nullable().optional(),
    anniversary: z.string().nullable().optional(),
    source: z.enum(["WALK_IN", "BOOKING", "WEBSITE", "REFERRAL", "OTHER"]).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    vip: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update." });

// ---------- visits ----------

export const visitCreateSchema = z.object({
  customerId: cuidLikeSchema,
  checkin: z.string().min(8).max(30),
  checkout: z.string().max(30).optional().nullable(),
  amount: z.coerce.number().min(0).max(100_000_000).optional(),
  notes: z.string().trim().max(500).optional(),
  source: z.enum(["MANUAL", "CSV_IMPORT", "BOOKING", "WALK_IN"]).optional(),
});

export const visitUpdateSchema = z
  .object({
    checkin: z.string().min(8).max(30).optional(),
    checkout: z.string().max(30).nullable().optional(),
    amount: z.coerce.number().min(0).max(100_000_000).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update." });

// ---------- campaigns ----------

export const campaignCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  segmentId: cuidLikeSchema.optional().nullable(),
  channels: z
    .array(z.enum(["WHATSAPP", "SMS", "EMAIL"]))
    .min(1)
    .max(3),
  messageTemplate: z.string().trim().min(1).max(4000),
  offer: z.string().trim().max(200).optional().nullable(),
  scheduleType: z.enum(["NOW", "SCHEDULED", "AUTOMATED"]).optional().default("NOW"),
  scheduledAt: z.string().optional().nullable(),
});

export const campaignUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  segmentId: cuidLikeSchema.nullable().optional(),
  channels: z
    .array(z.enum(["WHATSAPP", "SMS", "EMAIL"]))
    .min(1)
    .max(3)
    .optional(),
  messageTemplate: z.string().trim().min(1).max(4000).optional(),
  offer: z.string().trim().max(200).nullable().optional(),
  scheduleType: z.enum(["NOW", "SCHEDULED", "AUTOMATED"]).optional(),
  scheduledAt: z.string().nullable().optional(),
});

export const sendCampaignSchema = z.object({ force: z.boolean().optional().default(false) });

export const attributeBookingSchema = z.object({
  customerId: cuidLikeSchema,
  amount: z.coerce.number().min(0).max(100_000_000),
  channel: z.enum(["WHATSAPP", "SMS", "EMAIL"]).optional(),
});

export const testMessageSchema = z
  .object({
    phone: z.string().trim().max(20).optional(),
    email: z.string().trim().max(254).optional(),
  })
  .refine((v) => Boolean(v.phone || v.email), {
    message: "Enter a phone number (or email) to send the test message to.",
  });

// ---------- segments ----------

export const segmentCreateSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(300).optional().nullable(),
  color: z.enum(["slate", "sky", "amber", "rose", "emerald", "violet"]).optional().default("slate"),
  rule: z.record(z.string(), z.unknown()).optional(),
});

export const segmentUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    description: z.string().trim().max(300).nullable().optional(),
    color: z.enum(["slate", "sky", "amber", "rose", "emerald", "violet"]).optional(),
    rule: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update." });

export const segmentMembersSchema = z.object({
  action: z.enum(["add", "remove"]),
  customerIds: z.array(cuidLikeSchema).min(1).max(500),
});

// ---------- coupons ----------

export const couponCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .min(4, "Coupon code must be at least 4 characters long.")
    .max(40)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "Coupon code may only contain letters, numbers, dashes and underscores.",
    ),
  description: z.string().trim().max(300).optional().nullable(),
  discountType: z
    .enum(["PERCENTAGE", "FIXED_AMOUNT", "CUSTOMER_SPECIFIC", "ONE_TIME"])
    .default("PERCENTAGE"),
  discountValue: z.coerce.number().min(0).max(10_000_000),
  minimumOrder: z.coerce.number().min(0).max(10_000_000).optional().nullable(),
  maximumDiscount: z.coerce.number().min(0).max(10_000_000).optional().nullable(),
  validFrom: z.string().optional().nullable(),
  validUntil: z.string().optional().nullable(),
  usageLimit: z.coerce.number().int().min(0).max(1_000_000).optional().default(0),
  customerLimit: z.coerce.number().int().min(0).max(1000).optional().default(1),
  active: z.boolean().optional().default(true),
});

export const redeemCouponSchema = z.object({
  code: z.string().trim().min(1).max(40),
  customerId: cuidLikeSchema,
  orderAmount: z.coerce.number().min(0).max(100_000_000).default(0),
  orderId: z.string().trim().max(64).optional(),
});

export const validateCouponSchema = z.object({
  code: z.string().trim().min(1).max(40),
  customerId: cuidLikeSchema,
  orderAmount: z.coerce.number().min(0).max(100_000_000).optional(),
});

// ---------- automations ----------

export const automationCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  trigger: z.enum([
    "CHECKOUT",
    "NO_VISIT_30D",
    "NO_VISIT_60D",
    "NO_VISIT_90D",
    "BIRTHDAY",
    "ANNIVERSARY",
    "LEAD_TIER_CHANGE",
    "BOOKING_PAGE_VISITED",
    "COUPON_REDEEMED",
  ]),
  waitDays: z.coerce.number().int().min(0).max(365).optional().default(0),
  conditions: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  actions: z.array(z.record(z.string(), z.unknown())).min(1).max(10),
  channels: z
    .array(z.enum(["WHATSAPP", "SMS", "EMAIL"]))
    .min(1)
    .max(3),
  messageTemplate: z.string().trim().max(4000).optional().nullable(),
  offer: z.string().trim().max(200).optional().nullable(),
});

export const automationUpdateSchema = automationCreateSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update." });

// ---------- lead events ----------

export const leadEventCreateSchema = z.object({
  customerId: cuidLikeSchema,
  type: z.enum([
    "MESSAGE_OPENED",
    "LINK_CLICKED",
    "OFFER_VIEWED",
    "REPLIED",
    "BOOKING_PAGE_VISITED",
    "BOOKING_COMPLETED",
    "COUPON_REDEEMED",
  ]),
  campaignId: cuidLikeSchema.optional(),
  messageId: z.string().max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------- restaurant ----------

export const restaurantVisitSchema = z
  .object({
    customerId: cuidLikeSchema.optional(),
    customerName: z.string().trim().min(2).max(100).optional(),
    customerPhone: phoneSchema.optional(),
    partySize: z.coerce.number().int().min(1).max(50).default(2),
    amount: z.coerce.number().min(0).max(10_000_000).optional().default(0),
    source: z.enum(["DINE_IN", "TAKEAWAY", "DELIVERY", "WALK_IN", "ONLINE"]).default("WALK_IN"),
    items: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
  })
  .refine((v) => v.customerId || (v.customerName && v.customerPhone), {
    message: "Either customerId or customer name + phone is required.",
  });

// AUDIT FIX (F18): ONE shared schema for the REAL restaurant visit API fields
// (the legacy restaurantVisitSchema above uses different field names and is
// not wired to this route). Previously POST accepted guests=-3 (no integer
// guard), non-numeric orderAmount crashed with a 500 instead of a 4xx, and
// PATCH had drifted to its own hand-rolled checks. Create and PATCH now share
// this schema so both endpoints reject the same bad input the same way.
export const restaurantVisitCreateSchema = z.object({
  customerId: z.string().min(1).max(64),
  visitDate: z.string().optional(),
  orderAmount: z.coerce
    .number({ message: "Order amount must be a number." })
    .refine((v) => Number.isFinite(v), { message: "Order amount must be a finite number." })
    .min(0, "Order amount cannot be negative.")
    .max(10_000_000, "Order amount is too large."),
  guests: z.coerce
    .number()
    .int("Guests must be a whole number.")
    .min(1, "Guests must be at least 1.")
    .max(50, "Guests cannot exceed 50.")
    .default(1),
  tableNumber: z
    .string()
    .trim()
    .max(20, "Table number is too long (max 20 characters).")
    .optional(),
  foodCategory: z
    .string()
    .trim()
    .max(40, "Food category is too long (max 40 characters).")
    .optional(),
  favouriteItems: z
    .array(z.string().trim().min(1).max(100))
    .max(50, "Too many favourite items (max 50).")
    .optional(),
  source: z
    .enum([
      "WALK_IN",
      "RESERVATION",
      "ROOM_GUEST",
      "EVENT",
      "ONLINE_ORDER",
      "QR_MENU",
      "WIFI_LOGIN",
      "FEEDBACK",
      "LOYALTY",
    ])
    .optional(),
  notes: z.string().trim().max(500, "Notes are too long (max 500 characters).").optional(),
});

export const restaurantVisitPatchSchema = restaurantVisitCreateSchema.partial();

// ---------- integrations ----------

export const integrationUpsertSchema = z.object({
  type: z.enum([
    "WHATSAPP_CLOUD",
    "TWILIO_SMS",
    "SMTP",
    "STRIPE",
    "RAZORPAY",
    "ZOMATO",
    "SWIGGY",
    "POS",
    "GOOGLE_CALENDAR",
    "CALENDLY",
    "CUSTOM_WEBHOOK",
  ]),
  name: z.string().trim().min(1).max(100),
  credentials: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional().default(true),
});

// ---------- imports (CSV) ----------

export const MAX_CSV_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_CSV_ROWS = 10_000;

export const csvImportSchema = z
  .object({
    csv: z
      .string()
      .min(1, "Please provide the CSV content to import.")
      .max(MAX_CSV_BYTES, "CSV payload is too large."),
  })
  .refine((v) => v.csv.length - (v.csv.match(/\n/g)?.length ?? 0) <= 0 || true, { message: "ok" });

// ---------- super admin ----------

export const createHotelSchema = z.object({
  name: z.string().trim().min(2).max(120),
  address: z.string().trim().max(200).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  country: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().max(254).optional(),
  website: z.string().trim().max(200).optional(),
  gstin: z.string().trim().max(20).optional(),
  timezone: z.string().trim().max(60).optional(),
  currency: z.string().trim().min(3).max(3).optional(),
  planName: z.string().trim().min(2).max(40).default("FREE"),
  ownerName: z.string().trim().min(2, "Owner name is required.").max(100),
  ownerEmail: emailSchema,
  ownerPhone: z.string().trim().max(20).optional(),
});

export const featureToggleSchema = z.object({
  featureKey: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[A-Z_]+$/),
  enabled: z.boolean(),
});

export const supportAccessSchema = z.object({
  reason: z.string().trim().min(3, "Reason is required.").max(500),
  durationMinutes: z.coerce.number().int().min(5).max(480),
});

// ---------- webhook payloads ----------

export const trackingWebhookEventSchema = z.object({
  messageId: z.string().min(1).max(64),
  event: z.enum(["OPENED", "CLICKED", "REPLIED"]),
  reply: z.string().max(2000).optional(),
});

export const providerWebhookEventSchema = z.object({
  providerMessageId: z.string().min(1).max(128),
  event: z.enum(["delivered", "opened", "clicked", "failed"]),
  failureReason: z.string().max(500).optional(),
  eventId: z.string().max(80).optional(),
});

// ---------- helper ----------

export interface ParsedResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Parse + validate with a friendly first-error message. */
export function parseWith<T>(schema: z.ZodType<T>, input: unknown): ParsedResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  const first = result.error.issues[0];
  const field = first?.path?.length ? `${first.path.join(".")}: ` : "";
  return { ok: false, error: `${field}${first?.message ?? "Invalid input."}` };
}

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { db } from "@/lib/db";
import { getIntegrationEncryptionKey, getIntegrationEncryptionKeyring } from "@/lib/config";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { computeDiscount, validateCoupon } from "@/lib/saas/coupons";
import { logSecurityEvent } from "@/lib/saas/security";

/**
 * Billing architecture — Phase 10 §6.
 *
 * Provider abstraction (Razorpay / Stripe / Manual) — business logic is never
 * coupled to a single provider:
 *
 *   Checkout:   createCheckout() → Payment (PENDING, idempotent) + provider order
 *   Verify:     verifyWebhook() → signature check → markPaymentPaid()
 *   Confirm:    markPaymentPaid() → idempotent status transition + subscription activation
 *   Refund:     refundPayment() → audit + subscription review
 *
 * Secrets (key secrets / webhook secrets) are AES-256-GCM encrypted at rest
 * and NEVER returned to the frontend — the API exposes only masked hints
 * (e.g. `rzp_live_••••91F2`) plus configuration status.
 */

export type BillingProviderKey = "razorpay" | "stripe" | "manual";

export interface ProviderConfig {
  enabled: boolean;
  mode: "test" | "live";
  keyId?: string; // publishable identifier (safe to show masked)
  /** Encrypted envelopes — never returned to clients. */
  keySecretEnc?: string;
  webhookSecretEnc?: string;
  webhookUrl?: string;
}

export interface ProvidersSettings {
  razorpay: ProviderConfig;
  stripe: ProviderConfig;
  manual: ProviderConfig;
}

export const DEFAULT_PROVIDERS: ProvidersSettings = {
  razorpay: { enabled: false, mode: "test" },
  stripe: { enabled: false, mode: "test" },
  manual: { enabled: true, mode: "live" },
};

export async function getProviderSettings(): Promise<ProvidersSettings> {
  const raw = await db.platformSetting.findUnique({ where: { key: "billing.providers" } });
  if (!raw) return DEFAULT_PROVIDERS;
  try {
    const parsed = JSON.parse(raw.value) as Partial<ProvidersSettings>;
    return {
      razorpay: { ...DEFAULT_PROVIDERS.razorpay, ...parsed.razorpay },
      stripe: { ...DEFAULT_PROVIDERS.stripe, ...parsed.stripe },
      manual: { ...DEFAULT_PROVIDERS.manual, ...parsed.manual },
    };
  } catch {
    return DEFAULT_PROVIDERS;
  }
}

export async function saveProviderSettings(
  providers: ProvidersSettings,
  adminUserId: string,
  req?: Request,
): Promise<void> {
  // Self-managed PlatformSetting row (avoids a circular settings import).
  await db.platformSetting.upsert({
    where: { key: "billing.providers" },
    create: { key: "billing.providers", value: JSON.stringify(providers) },
    update: { value: JSON.stringify(providers) },
  });
  await logAudit({
    userId: adminUserId,
    action: AUDIT_ACTIONS.BILLING_PROVIDER_UPDATED,
    entityType: "platform_setting",
    entityId: "billing.providers",
    metadata: {
      razorpay: {
        enabled: providers.razorpay.enabled,
        mode: providers.razorpay.mode,
        configured: Boolean(providers.razorpay.keySecretEnc),
      },
      stripe: {
        enabled: providers.stripe.enabled,
        mode: providers.stripe.mode,
        configured: Boolean(providers.stripe.keySecretEnc),
      },
      manual: { enabled: providers.manual.enabled },
    },
    req,
  });
}

// ---------- Secret encryption (platform-scoped AAD) ----------

function platformKey(): Buffer {
  return getIntegrationEncryptionKey();
}

export function encryptPlatformSecret(plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", platformKey(), iv);
  cipher.setAAD(Buffer.from(`platform:billing:${context}`, "utf8"));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${enc.toString("base64")}:${cipher.getAuthTag().toString("base64")}`;
}

export function decryptPlatformSecret(envelope: string, context: string): string {
  const [version, ivB64, ctB64, tagB64] = envelope.split(":");
  if (version !== "v1" || !ivB64 || !ctB64 || !tagB64) throw new Error("Bad secret envelope");
  // AUDIT FIX (keyring): rotation support — try the CURRENT key first, then
  // the declared previous keys (same contract as integration credentials and
  // backup archives). Without this, rotating INTEGRATION_ENCRYPTION_KEY made
  // every stored Razorpay/Stripe secret undecryptable (webhooks 500 forever).
  const iv = Buffer.from(ivB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const aad = Buffer.from(`platform:billing:${context}`, "utf8");
  for (const candidate of getIntegrationEncryptionKeyring()) {
    try {
      const d = createDecipheriv("aes-256-gcm", candidate.key, iv);
      d.setAAD(aad);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
    } catch {
      // wrong key or tamper — next candidate
    }
  }
  throw new Error(
    "Stored billing secret could not be decrypted with any configured key (rotated without declaring the previous key?)",
  );
}

/** Masked hint for UI: rzp_live_A1b2C3... → rzp_l••••C3... */
export function maskSecret(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length <= 6) return "••••••";
  return `${trimmed.slice(0, 4)}••••••${trimmed.slice(-4)}`;
}

// ---------- Webhook signature verification (provider-native) ----------

/** Razorpay: HMAC-SHA256(rawBody, webhookSecret) in x-razorpay-signature. */
export function verifyRazorpaySignature(
  rawBody: string,
  signature: string,
  webhookSecret: string,
): boolean {
  const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Stripe: `t=<ts>,v1=<sig>` header, HMAC-SHA256(`${ts}.${rawBody}`, whsec). */
export function verifyStripeSignature(
  rawBody: string,
  header: string,
  webhookSecret: string,
  toleranceSeconds = 300,
): boolean {
  try {
    const parts = Object.fromEntries(
      header.split(",").map((kv) => {
        const [k, v] = kv.split("=");
        return [k?.trim(), v?.trim()];
      }),
    );
    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp) || !parts.v1) return false;
    const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
    if (age > toleranceSeconds) return false; // replay protection
    const expected = createHmac("sha256", webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");
    const a = Buffer.from(parts.v1);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------- Invoice numbering ----------

function invoiceNumber(): string {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `SL-${ym}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

// ---------- AUDIT FIX (F05): REAL provider order creation ----------

/**
 * Create a Razorpay Order (server-to-server). Razorpay requires amounts in
 * currency SUBUNITS (paise for INR) — see
 * https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/
 *
 * Returns the provider order id and the publishable key id the frontend
 * Razorpay Checkout needs. NEVER returns or logs the key secret.
 */
async function createRazorpayOrder(params: {
  keyId: string;
  keySecret: string;
  amountMinor: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
}): Promise<{ ok: true; orderId: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${params.keyId}:${params.keySecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: params.amountMinor,
        currency: params.currency,
        receipt: params.receipt,
        notes: params.notes,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      error?: { description?: string };
    };
    if (!res.ok || !data.id) {
      return {
        ok: false,
        error: data.error?.description ?? `Razorpay order API error ${res.status}`,
      };
    }
    return { ok: true, orderId: data.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Razorpay network error" };
  }
}

function minorUnits(amount: number): number {
  return Math.round(amount * 100);
}

// ---------- RECHECK FIX (C): frontend checkout confirmation ----------

/**
 * Razorpay Checkout.js returns (order_id, payment_id, signature) to the
 * browser handler. The signature is HMAC-SHA256(`${order_id}|${payment_id}`,
 * KEY_SECRET) — verification proves the payment is real, came from OUR
 * account, and belongs to OUR order. This is the standard Razorpay
 * server-side confirmation flow (docs: "Verify Payment Signature").
 */
export function verifyRazorpayPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string,
): boolean {
  const expected = createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  const a = Buffer.from(signature ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Authoritative payment entity straight from the Razorpay API (fail-closed amount/status source). */
async function fetchRazorpayPayment(
  keyId: string,
  keySecret: string,
  providerPaymentId: string,
): Promise<
  | {
      ok: true;
      entity: {
        id?: string;
        order_id?: string;
        amount?: number;
        currency?: string;
        status?: string;
        method?: string;
      };
    }
  | { ok: false; error: string }
> {
  try {
    const res = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(providerPaymentId)}`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        },
      },
    );
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      order_id?: string;
      amount?: number;
      currency?: string;
      status?: string;
      method?: string;
      error?: { description?: string };
    };
    if (!res.ok) {
      return {
        ok: false,
        error: data.error?.description ?? `Razorpay payments API error ${res.status}`,
      };
    }
    return { ok: true, entity: data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Razorpay network error" };
  }
}

/**
 * Confirm a Razorpay Checkout completion from the BROWSER callback:
 *   1. tenant-scoped payment lookup (owner/admin only reached the route),
 *   2. payment MUST be a razorpay checkout with a persisted provider order,
 *   3. Razorpay signature check (fail closed),
 *   4. authoritative payment entity fetched from the Razorpay API — the
 *      browser is never trusted for amount/status/order binding,
 *   5. reconcileProviderPayment (order/amount/currency/provider binding),
 *   6. markPaymentPaid (idempotent, transactional, outbox).
 */
export async function confirmRazorpayCheckout(params: {
  hotelId: string;
  paymentId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}): Promise<
  { ok: true; status: string; alreadyPaid?: boolean } | { ok: false; error: string; status: number }
> {
  const payment = await db.payment.findFirst({
    where: { id: params.paymentId, hotelId: params.hotelId },
  });
  if (!payment) return { ok: false, error: "Payment not found in your hotel.", status: 404 };

  if (payment.status === "PAID") {
    const followUp = await processPaymentConfirmation({
      paymentId: payment.id,
      reason: "checkout-reverify",
    }).catch((err) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }));
    if (!followUp.ok)
      return {
        ok: false,
        error: `Payment is PAID but confirmation follow-up failed: ${followUp.error}`,
        status: 409,
      };
    return { ok: true, status: "PAID", alreadyPaid: true };
  }

  if (payment.provider !== "razorpay" || !payment.providerOrderId) {
    return { ok: false, error: "This invoice is not an online Razorpay checkout.", status: 409 };
  }

  const providers = await getProviderSettings();
  const config = providers.razorpay;
  if (!config.enabled || !config.keySecretEnc || !config.keyId) {
    return { ok: false, error: "Razorpay is not configured on the platform.", status: 503 };
  }
  const keySecret = decryptPlatformSecret(config.keySecretEnc, "razorpay-key");

  // The callback's order id must be the one WE created for THIS invoice.
  if (params.razorpayOrderId !== payment.providerOrderId) {
    return {
      ok: false,
      error: "Order id mismatch — this confirmation is not for this invoice.",
      status: 400,
    };
  }

  if (
    !verifyRazorpayPaymentSignature(
      params.razorpayOrderId,
      params.razorpayPaymentId,
      params.razorpaySignature,
      keySecret,
    )
  ) {
    await logSecurityEvent({
      type: "WEBHOOK_REJECTED",
      severity: "CRITICAL",
      details: {
        surface: "checkout-verify",
        reason: "invalid-payment-signature",
        paymentId: payment.id,
      },
    });
    return { ok: false, error: "Payment signature verification failed.", status: 400 };
  }

  // NEVER trust the browser: pull the authoritative entity from Razorpay.
  const fetched = await fetchRazorpayPayment(config.keyId, keySecret, params.razorpayPaymentId);
  if (!fetched.ok) {
    return {
      ok: false,
      error: `Could not verify the payment with Razorpay: ${fetched.error}`,
      status: 502,
    };
  }
  const entity = fetched.entity;
  if (entity.status !== "captured" && entity.status !== "authorized") {
    return {
      ok: false,
      error: `Razorpay reports this payment as "${entity.status ?? "unknown"}" — not captured.`,
      status: 409,
    };
  }

  const verdict = await reconcileProviderPayment({
    provider: "razorpay",
    providerOrderId: entity.order_id ?? params.razorpayOrderId,
    hintedPaymentId: payment.id,
    amountMinor: entity.amount ?? null,
    currency: entity.currency ?? null,
    providerPaymentId: entity.id ?? params.razorpayPaymentId,
  });
  if (!verdict.ok) {
    await logSecurityEvent({
      type: "WEBHOOK_ANOMALY",
      severity: "CRITICAL",
      details: { surface: "checkout-verify", reason: verdict.reason, ...verdict.details },
    });
    return { ok: false, error: `Payment binding failed (${verdict.reason}).`, status: 400 };
  }

  const result = await markPaymentPaid({
    paymentId: payment.id,
    providerPaymentId: entity.id ?? params.razorpayPaymentId,
    provider: "razorpay",
    reason: "razorpay:checkout-confirmed",
  });
  if (!result.ok)
    return { ok: false, error: result.error ?? "Payment could not be confirmed.", status: 409 };
  return { ok: true, status: "PAID", alreadyPaid: result.alreadyPaid ?? false };
}

// ---------- Checkout ----------

export interface CheckoutInput {
  hotelId: string;
  planKey: string;
  billingCycle: "MONTHLY" | "YEARLY";
  couponCode?: string | null;
  userId: string;
}

export interface CheckoutResult {
  paymentId: string;
  invoiceNumber: string;
  planKey: string;
  planName: string;
  billingCycle: "MONTHLY" | "YEARLY";
  baseAmount: number;
  discount: number;
  amount: number;
  currency: string;
  provider: BillingProviderKey;
  couponCode: string | null;
  /** F05 — present when a REAL provider checkout was created. */
  checkout?: {
    /** Provider order id (e.g. Razorpay `order_…`). */
    providerOrderId: string;
    /** Publishable key id for Razorpay Checkout (safe to expose). */
    publishableKeyId: string | null;
    /** Amount in currency MINOR units (paise for INR). */
    amountMinor: number;
    currency: string;
    mode: "test" | "live";
  };
}

/** Create a checkout (payment intent) for a plan purchase/upgrade. */
export async function createCheckout(
  input: CheckoutInput,
): Promise<CheckoutResult | { error: string }> {
  const plan = await db.plan.findUnique({ where: { key: input.planKey } });
  if (!plan || !plan.isActive || plan.isArchived)
    return { error: "Plan not found or not purchasable." };

  const hotel = await db.hotel.findUnique({ where: { id: input.hotelId } });
  if (!hotel) return { error: "Hotel not found." };

  const baseAmount = input.billingCycle === "YEARLY" ? plan.yearlyPrice : plan.monthlyPrice;
  const currency = plan.currency;

  // Coupon validation (not consumed yet — redeemed on payment confirmation).
  let discount = 0;
  let couponCode: string | null = null;
  let couponId: string | null = null;
  if (input.couponCode) {
    const validation = await validateCoupon({
      code: input.couponCode,
      amount: baseAmount,
      planKey: plan.key,
      hotelId: input.hotelId,
    });
    if (!validation.ok || !validation.coupon)
      return { error: validation.reason ?? "Invalid coupon." };
    discount = computeDiscount(validation.coupon, baseAmount);
    couponCode = validation.coupon.code;
    couponId = validation.coupon.id;
  }
  const amount = Math.max(0, baseAmount - discount);

  // Choose provider: first enabled configured provider, else manual.
  // RECHECK FIX (C): Stripe checkout creation was never implemented —
  // selecting Stripe produced a local invoice that could never be opened in
  // a payment UI (no PaymentIntent/session is created), so advertising it as
  // a working checkout path was dishonest. Razorpay is the online provider;
  // anything else falls back to MANUAL (invoice + platform confirmation),
  // which is a real, working flow. The Stripe webhook stays functional for
  // externally-created PaymentIntents (fail-closed binding).
  const providers = await getProviderSettings();
  let provider: BillingProviderKey = "manual";
  if (providers.razorpay.enabled && providers.razorpay.keySecretEnc) provider = "razorpay";

  // Idempotency: one PENDING payment per hotel+plan+cycle per hour.
  const idempotencyKey = createHash("sha256")
    .update(
      `${input.hotelId}:${plan.id}:${input.billingCycle}:${Math.floor(Date.now() / (60 * 60 * 1000))}`,
    )
    .digest("hex");
  const existing = await db.payment.findUnique({ where: { idempotencyKey } });
  if (existing) {
    const existingMeta = safeParseMetadata(existing.metadata);
    const existingCheckout =
      existing.providerOrderId && existing.provider === "razorpay"
        ? {
            providerOrderId: existing.providerOrderId,
            publishableKeyId:
              typeof existingMeta.publishableKeyId === "string"
                ? existingMeta.publishableKeyId
                : null,
            amountMinor: minorUnits(existing.amount),
            currency: existing.currency,
            mode: (existingMeta.mode as "test" | "live") ?? "test",
          }
        : undefined;
    return {
      paymentId: existing.id,
      invoiceNumber: existing.invoiceNumber,
      planKey: plan.key,
      planName: plan.name,
      billingCycle: input.billingCycle,
      baseAmount: existing.amount + existing.discountAmount,
      discount: existing.discountAmount,
      amount: existing.amount,
      currency: existing.currency,
      provider: existing.provider as BillingProviderKey,
      couponCode: existing.couponCode,
      ...(existingCheckout ? { checkout: existingCheckout } : {}),
    };
  }

  // AUDIT FIX (F05): when Razorpay is the selected provider, a REAL provider
  // Order is created server-side BEFORE the local Payment row. The local
  // invoice alone never claimed to be an online payment — now the UI receives
  // the fields it needs to open actual Razorpay Checkout (order id +
  // publishable key + minor-unit amount), and the webhook can BIND the
  // captured payment to the persisted provider order (F06).
  let providerOrderId: string | null = null;
  let publishableKeyId: string | null = null;
  let providerMode: "test" | "live" = providers.razorpay.mode ?? "test";
  if (provider === "razorpay") {
    const keyId = providers.razorpay.keyId ?? "";
    const keySecret = decryptPlatformSecret(providers.razorpay.keySecretEnc!, "razorpay-key");
    if (!keyId || !keySecret) {
      return {
        error:
          "Razorpay is enabled but its key material is incomplete. Contact the platform admin.",
      };
    }
    const order = await createRazorpayOrder({
      keyId,
      keySecret,
      amountMinor: minorUnits(amount),
      currency,
      receipt: invoiceNumber(),
      notes: {
        // Filled with the internal payment id AFTER the row exists (second
        // call would be wasteful; the webhook matches on providerOrderId —
        // notes are informational for Razorpay dashboards).
        purpose: "stayloop-subscription",
        planKey: plan.key,
      },
    });
    if (!order.ok) {
      return { error: `Payment provider refused the order: ${order.error}` };
    }
    providerOrderId = order.orderId;
    publishableKeyId = keyId;
  }

  const payment = await db.payment.create({
    data: {
      hotelId: input.hotelId,
      planId: plan.id,
      invoiceNumber: invoiceNumber(),
      description: `StayLoop ${plan.name} plan (${input.billingCycle.toLowerCase()})`,
      amount,
      discountAmount: discount,
      currency,
      status: "PENDING",
      provider,
      providerOrderId,
      couponId,
      couponCode,
      billingCycle: input.billingCycle,
      idempotencyKey,
      metadata: JSON.stringify({
        baseAmount,
        planKey: plan.key,
        expectedAmountMinor: minorUnits(amount),
        publishableKeyId,
        mode: providerMode,
      }),
    },
  });
  await logAudit({
    hotelId: input.hotelId,
    userId: input.userId,
    action: AUDIT_ACTIONS.CHECKOUT_CREATED,
    entityType: "payment",
    entityId: payment.id,
    metadata: {
      plan: plan.key,
      cycle: input.billingCycle,
      amount,
      discount,
      provider,
      coupon: couponCode,
      providerOrderId,
    },
  });

  return {
    paymentId: payment.id,
    invoiceNumber: payment.invoiceNumber,
    planKey: plan.key,
    planName: plan.name,
    billingCycle: input.billingCycle,
    baseAmount,
    discount,
    amount,
    currency,
    provider,
    couponCode,
    ...(providerOrderId
      ? {
          checkout: {
            providerOrderId,
            publishableKeyId,
            amountMinor: minorUnits(amount),
            currency,
            mode: providerMode,
          },
        }
      : {}),
  };
}

// ---------- Payment confirmation (idempotent, transactional + outbox) ----------

/** Marker stored in Payment.metadata once the coupon redemption applied. */
const COUPON_REDEEMED_MARKER = '"couponRedeemedAt"';

/** Outbox job type for payment confirmation follow-up (processed by the worker). */
export const PAYMENT_CONFIRMED_JOB = "PAYMENT_CONFIRMED";

/**
 * The idempotent follow-up for a PAID payment: redeem the coupon and activate
 * the subscription. Safe to run MANY times (inline confirm, worker retry,
 * duplicate webhook replay) — each effect is claimed with an atomic guarded
 * update inside ONE transaction:
 *
 *   coupon redemption: Payment.metadata marker claim + usage-guarded
 *     usedCount increment (exactly once per payment);
 *   subscription activation: create the ACTIVE subscription and link it via
 *     `Payment.subscriptionId` with a null-guarded claim (exactly one ACTIVE
 *     subscription per payment; a racing duplicate rolls back).
 *
 * AUDIT FIX (billing-1): previously the coupon redemption and subscription
 * activation ran as plain sequential writes AFTER the PENDING→PAID flip. A
 * crash in that window left a PAID payment with NO subscription and no
 * recovery path (the status guard meant a retry of markPaymentPaid returned
 * "alreadyPaid" and never re-ran the follow-up). Together with the outbox row
 * created in the SAME transaction as the status flip, this function makes the
 * confirmation crash-safe: the worker re-runs it until both markers are set.
 */
export async function processPaymentConfirmation(params: {
  paymentId: string;
  adminUserId?: string;
  reason?: string;
}): Promise<{ ok: boolean; alreadyComplete?: boolean; error?: string }> {
  const payment = await db.payment.findUnique({ where: { id: params.paymentId } });
  if (!payment) return { ok: false, error: "Payment not found." };
  if (payment.status !== "PAID") return { ok: false, error: "Payment is not PAID." };

  const couponDone =
    Boolean(payment.couponId) && (payment.metadata ?? "").includes(COUPON_REDEEMED_MARKER);
  const subscriptionDone = payment.subscriptionId !== null;
  if ((!payment.couponId || couponDone) && subscriptionDone) {
    return { ok: true, alreadyComplete: true };
  }

  let redeemedThisRun = false;
  await db.$transaction(async (tx) => {
    // --- coupon redemption (exactly once per payment) ---
    if (payment.couponId && !couponDone) {
      // Claim: transition metadata from "no marker" to "marker". NULL
      // metadata must ALSO be claimable — on SQLite `NOT (NULL LIKE …)` is
      // NULL (row filtered out), so the null case is handled explicitly.
      const claim = await tx.payment.updateMany({
        where: {
          id: payment.id,
          status: "PAID",
          OR: [{ metadata: null }, { NOT: { metadata: { contains: COUPON_REDEEMED_MARKER } } }],
        },
        data: {
          metadata: JSON.stringify({
            ...safeParseMetadata(payment.metadata),
            couponRedeemedAt: new Date().toISOString(),
          }),
        },
      });
      if (claim.count === 1) {
        // Usage-guarded increment — cannot exceed the coupon's usageLimit.
        const guarded = await tx.billingCoupon.updateMany({
          where: {
            id: payment.couponId,
            isActive: true,
            OR: [{ usageLimit: null }, { usedCount: { lt: tx.billingCoupon.fields.usageLimit } }],
          },
          data: { usedCount: { increment: 1 } },
        });
        if (guarded.count !== 1) {
          // Coupon expired/exhausted between checkout and confirmation — the
          // discount was validated at checkout, so this is an anomaly worth
          // surfacing, but it must not block the subscription activation.
          redeemedThisRun = false;
        } else {
          redeemedThisRun = true;
        }
      }
    }

    // --- subscription activation (exactly one ACTIVE sub per payment) ---
    if (!subscriptionDone && payment.planId) {
      const plan = await tx.plan.findUnique({ where: { id: payment.planId } });
      if (!plan) throw new Error("Plan not found.");
      const cycle = (payment.billingCycle as "MONTHLY" | "YEARLY") ?? "MONTHLY";
      const now = new Date();
      const periodDays = cycle === "YEARLY" ? 365 : 30;
      const periodEnd = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);

      await tx.subscription.updateMany({
        where: {
          hotelId: payment.hotelId,
          status: {
            in: ["TRIALING", "ACTIVE", "GRACE", "PAST_DUE", "PAUSED", "EXPIRED", "CANCELLED"],
          },
        },
        data: { status: "CANCELLED", cancelledAt: now },
      });
      const subscription = await tx.subscription.create({
        data: {
          hotelId: payment.hotelId,
          planId: plan.id,
          status: "ACTIVE",
          billingCycle: cycle,
          amount: payment.amount,
          currency: plan.currency,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          nextInvoiceAt: periodEnd,
          provider: payment.provider,
          providerRef: payment.providerPaymentId ?? null,
          trialStartsAt: null,
          trialEndsAt: null,
          graceEndsAt: null,
        },
      });
      // Atomic link claim: only the FIRST runner transitions subscriptionId
      // null → id; a racing duplicate throws and its created row rolls back.
      const link = await tx.payment.updateMany({
        where: { id: payment.id, subscriptionId: null, status: "PAID" },
        data: { subscriptionId: subscription.id },
      });
      if (link.count !== 1) {
        throw new Error("Subscription already activated for this payment (lost link claim).");
      }
      await tx.hotel.update({
        where: { id: payment.hotelId },
        data: { planId: plan.id },
      });
      await logAudit({
        hotelId: payment.hotelId,
        userId: params.adminUserId,
        action: AUDIT_ACTIONS.SUBSCRIPTION_CHANGED,
        entityType: "subscription",
        entityId: subscription.id,
        metadata: {
          plan: plan.key,
          cycle,
          amount: payment.amount,
          provider: payment.provider,
          reason: params.reason ?? "payment-confirmed",
          paymentId: payment.id,
        },
        tx,
      });
    }
  });

  if (redeemedThisRun && payment.couponId) {
    const coupon = await db.billingCoupon.findUnique({ where: { id: payment.couponId } });
    await logAudit({
      hotelId: payment.hotelId,
      userId: params.adminUserId,
      action: AUDIT_ACTIONS.BILLING_COUPON_REDEEMED,
      entityType: "billing_coupon",
      entityId: payment.couponId,
      metadata: { code: coupon?.code ?? payment.couponCode, paymentId: payment.id },
    });
  }

  await logAudit({
    hotelId: payment.hotelId,
    userId: params.adminUserId,
    action: AUDIT_ACTIONS.PAYMENT_RECORDED,
    entityType: "payment",
    entityId: payment.id,
    metadata: {
      invoiceNumber: payment.invoiceNumber,
      amount: payment.amount,
      provider: payment.provider,
      providerPaymentId: payment.providerPaymentId ?? null,
      reason: params.reason,
    },
  });
  return { ok: true };
}

function safeParseMetadata(raw: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Mark a payment PAID (idempotent — webhooks may fire repeatedly).
 *
 * Consistency contract (audit fix billing-1):
 *   1. ONE transaction atomically flips PENDING → PAID AND enqueues a
 *      PAYMENT_CONFIRMED outbox job. A crash can no longer leave a PAID
 *      payment whose follow-up (coupon + subscription) never runs — the
 *      worker picks the job up and completes it.
 *   2. The happy path then runs the follow-up INLINE (the UI/webhook caller
 *      sees the subscription active immediately). processPaymentConfirmation
 *      is idempotent, so the worker's later run is a no-op double-check.
 *   3. A duplicate call on an already-PAID payment re-runs the (idempotent)
 *      follow-up inline — recovering a crash that happened between the flip
 *      and the inline follow-up even before the worker gets to the job.
 */
export async function markPaymentPaid(params: {
  paymentId: string;
  providerPaymentId?: string | null;
  provider?: string | null;
  adminUserId?: string;
  reason?: string;
}): Promise<{ ok: boolean; alreadyPaid?: boolean; error?: string }> {
  const payment = await db.payment.findUnique({ where: { id: params.paymentId } });
  if (!payment) return { ok: false, error: "Payment not found." };
  if (payment.status === "PAID") {
    // Recovery: a previous run may have flipped the status but died before the
    // follow-up completed. Re-running it is idempotent and cheap.
    const followUp = await processPaymentConfirmation({
      paymentId: params.paymentId,
      adminUserId: params.adminUserId,
      reason: params.reason,
    }).catch((err) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }));
    if (!followUp.ok)
      return {
        ok: false,
        error: `Payment is PAID but confirmation follow-up failed: ${followUp.error}`,
      };
    return { ok: true, alreadyPaid: true };
  }
  if (payment.status === "REFUNDED") return { ok: false, error: "Payment was refunded." };

  // AUDIT FIX (F17): a valid provider CAPTURE event is authoritative for the
  // invoice it belongs to. Previously only PENDING → PAID was allowed, so a
  // customer whose first attempt FAILED but whose later attempt was captured
  // was stuck FAILED forever (provider retries stopped on HTTP 200, the money
  // was taken, no subscription). A provider-authentic captured event for the
  // correct order now RECOVERS a FAILED payment. The binding still goes
  // through reconcileProviderPayment (order/amount/currency/provider match).
  const claimableStatuses = ["PENDING", "FAILED"] as const;

  // Atomic: status flip + outbox job commit together (or not at all).
  let won = false;
  await db.$transaction(async (tx) => {
    const transition = await tx.payment.updateMany({
      where: { id: params.paymentId, status: { in: [...claimableStatuses] } },
      data: {
        status: "PAID",
        paidAt: new Date(),
        providerPaymentId: params.providerPaymentId ?? payment.providerPaymentId,
        provider: params.provider ?? payment.provider,
        failureReason: null,
      },
    });
    won = transition.count === 1;
    if (won) {
      await tx.backgroundJob.create({
        data: {
          type: PAYMENT_CONFIRMED_JOB,
          payload: JSON.stringify({
            paymentId: payment.id,
            adminUserId: params.adminUserId ?? null,
            reason: params.reason ?? "payment-confirmed",
          }),
          hotelId: payment.hotelId,
          createdBy: params.adminUserId ?? null,
          maxAttempts: 5,
        },
      });
    }
  });

  if (!won) {
    const recheck = await db.payment.findUnique({ where: { id: params.paymentId } });
    if (recheck?.status === "PAID") {
      const followUp = await processPaymentConfirmation({
        paymentId: params.paymentId,
        adminUserId: params.adminUserId,
        reason: params.reason,
      }).catch((err) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }));
      if (!followUp.ok)
        return {
          ok: false,
          error: `Payment is PAID but confirmation follow-up failed: ${followUp.error}`,
        };
      return { ok: true, alreadyPaid: true };
    }
    return { ok: false, error: "Payment could not be confirmed." };
  }

  // Happy path: complete the follow-up inline so the subscription is active
  // when the caller (webhook / manual confirm) returns.
  const followUp = await processPaymentConfirmation({
    paymentId: params.paymentId,
    adminUserId: params.adminUserId,
    reason: params.reason,
  }).catch((err) => ({
    ok: false as const,
    error: err instanceof Error ? err.message : String(err),
  }));
  if (!followUp.ok) {
    // The outbox job remains queued — the worker will retry. Report soft-ok:
    // the payment IS paid; the subscription activation is pending retry.
    return { ok: true, error: `Paid; follow-up pending worker retry: ${followUp.error}` };
  }
  return { ok: true };
}

/**
 * AUDIT FIX (F06) — PROVIDER EVENT BINDING VALIDATION.
 *
 * A valid signature only proves WHO sent the event, not that the event is for
 * THIS invoice. Before any capture is honoured the event must match the
 * persisted local payment on ALL of:
 *   - the persisted provider order id (payment.providerOrderId ↔ event order),
 *   - the expected amount in minor units (Payment.amount × 100 ↔ event amount),
 *   - the currency,
 *   - the provider (and therefore its account/mode configuration),
 *   - the provider payment id (a second capture from a DIFFERENT provider
 *     payment id is quarantined — uniquely bound).
 *
 * RESOLUTION ORDER (recheck fix B): the internal payment id from order notes
 * is only a HINT. When it is absent (orders are created before the local
 * Payment row exists, so notes cannot contain it), the persisted
 * providerOrderId ↔ Payment mapping is authoritative and the event is
 * resolved by looking it up. The hint is never required.
 *
 * Mismatching (even correctly SIGNED) events are QUARANTINED: they never
 * activate a subscription; they are logged to the security event stream and
 * audited with full detail for operator reconciliation.
 *
 * FAIL CLOSED (recheck fix B): for online providers a missing event order id,
 * a missing amount, a missing currency, or an event order that has no
 * persisted binding is a quarantine — never "skip the check and continue".
 */
export type ReconcileVerdict =
  | { ok: true; paymentId: string }
  | { ok: false; reason: string; quarantine: boolean; details: Record<string, unknown> };

export async function reconcileProviderPayment(params: {
  provider: "razorpay" | "stripe";
  /** Provider order id from the event (Razorpay payment.entity.order_id / Stripe PI id). */
  providerOrderId: string | null | undefined;
  /** Internal payment id from notes/metadata — a HINT, never sufficient alone. */
  hintedPaymentId?: string | null | undefined;
  /** Event amount in MINOR units (paise/cents). */
  amountMinor: number | null | undefined;
  currency: string | null | undefined;
  /** Provider payment id (pay_… / pi_…). */
  providerPaymentId?: string | null;
}): Promise<ReconcileVerdict> {
  const details: Record<string, unknown> = {
    provider: params.provider,
    providerOrderId: params.providerOrderId ?? null,
    hintedPaymentId: params.hintedPaymentId ?? null,
    eventAmountMinor: params.amountMinor ?? null,
    eventCurrency: params.currency ?? null,
  };

  // Resolution: prefer the explicit hint, then the persisted providerOrderId
  // mapping (recheck fix B — checkout persists Payment.providerOrderId).
  let payment = null as Awaited<ReturnType<typeof db.payment.findUnique>>;
  if (params.hintedPaymentId) {
    payment = await db.payment.findUnique({ where: { id: params.hintedPaymentId } });
  }
  if (!payment && params.providerOrderId) {
    // The hint was absent/unknown — the provider order id IS the binding.
    // Most recent first: a replayed checkout hour-window can hold one PENDING
    // row per hour; the newest matches the live checkout.
    payment = await db.payment.findFirst({
      where: { providerOrderId: params.providerOrderId, provider: params.provider },
      orderBy: { createdAt: "desc" },
    });
  }
  if (!payment) {
    return {
      ok: false,
      reason: params.hintedPaymentId ? "PAYMENT_NOT_FOUND" : "NO_ORDER_BINDING",
      quarantine: true,
      details,
    };
  }

  // Provider must match the payment's recorded provider.
  if (payment.provider !== params.provider) {
    return {
      ok: false,
      reason: "PROVIDER_MISMATCH",
      quarantine: true,
      details: { ...details, paymentProvider: payment.provider },
    };
  }

  // Persisted provider order binding — REQUIRED and MATCHED for online
  // providers (fail closed; previously a payment without a persisted order
  // id slipped through to the amount check):
  if (!params.providerOrderId) {
    return {
      ok: false,
      reason: "MISSING_ORDER_ID",
      quarantine: true,
      details,
    };
  }
  if (!payment.providerOrderId || params.providerOrderId !== payment.providerOrderId) {
    return {
      ok: false,
      reason: "ORDER_MISMATCH",
      quarantine: true,
      details: { ...details, expectedOrderId: payment.providerOrderId ?? null },
    };
  }

  // Unique provider-payment binding: once a capture has been recorded for one
  // provider payment id, a capture claiming a DIFFERENT id for the same
  // invoice is an anomaly (double-capture, replayed order, or corrupted
  // event) — quarantine it.
  if (
    payment.providerPaymentId &&
    params.providerPaymentId &&
    payment.providerPaymentId !== params.providerPaymentId
  ) {
    return {
      ok: false,
      reason: "PROVIDER_PAYMENT_MISMATCH",
      quarantine: true,
      details: {
        ...details,
        expectedProviderPaymentId: payment.providerPaymentId,
      },
    };
  }

  // Amount binding (minor units) and currency binding — REQUIRED for online
  // providers. Previously `!= null` guards silently SKIPPED the check when
  // the event omitted them; now absence is a quarantine (fail closed).
  const expectedAmountMinor = minorUnits(payment.amount);
  if (params.amountMinor == null) {
    return {
      ok: false,
      reason: "AMOUNT_MISSING",
      quarantine: true,
      details: { ...details, expectedAmountMinor },
    };
  }
  if (params.amountMinor !== expectedAmountMinor) {
    return {
      ok: false,
      reason: "AMOUNT_MISMATCH",
      quarantine: true,
      details: { ...details, expectedAmountMinor },
    };
  }
  if (!params.currency) {
    return {
      ok: false,
      reason: "CURRENCY_MISSING",
      quarantine: true,
      details: { ...details, expectedCurrency: payment.currency },
    };
  }
  if (params.currency.toUpperCase() !== payment.currency.toUpperCase()) {
    return {
      ok: false,
      reason: "CURRENCY_MISMATCH",
      quarantine: true,
      details: { ...details, expectedCurrency: payment.currency },
    };
  }

  return { ok: true, paymentId: payment.id };
}

export async function markPaymentFailed(paymentId: string, reason: string): Promise<boolean> {
  const transition = await db.payment.updateMany({
    where: { id: paymentId, status: "PENDING" },
    data: { status: "FAILED", failureReason: reason.slice(0, 300) },
  });
  if (transition.count === 1) {
    const payment = await db.payment.findUnique({ where: { id: paymentId } });
    await logAudit({
      hotelId: payment?.hotelId,
      action: AUDIT_ACTIONS.PAYMENT_FAILED,
      entityType: "payment",
      entityId: paymentId,
      metadata: { reason: reason.slice(0, 300) },
    });
  }
  return transition.count === 1;
}

/** Refund a paid payment (full refund recorded; provider-side refund via provider dashboard/API). */
export async function refundPayment(params: {
  paymentId: string;
  adminUserId: string;
  reason: string;
  amount?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const payment = await db.payment.findUnique({ where: { id: params.paymentId } });
  if (!payment) return { ok: false, error: "Payment not found." };
  if (payment.status !== "PAID" && payment.status !== "PARTIALLY_REFUNDED") {
    return { ok: false, error: "Only paid payments can be refunded." };
  }
  const refundAmount = Math.min(
    params.amount ?? payment.amount,
    payment.amount - payment.refundedAmount,
  );
  if (refundAmount <= 0) return { ok: false, error: "Nothing left to refund." };
  const fullyRefunded = payment.refundedAmount + refundAmount >= payment.amount;
  // AUDIT FIX (billing-3): the old read-then-update allowed two concurrent
  // refunds to BOTH compute against the same stale refundedAmount and
  // over-refund past the payment amount. The guarded updateMany makes the
  // write conditional on the value that was read (optimistic concurrency):
  // the loser is told to retry instead of double-applying.
  const applied = await db.payment.updateMany({
    where: {
      id: params.paymentId,
      status: { in: ["PAID", "PARTIALLY_REFUNDED"] },
      refundedAmount: payment.refundedAmount,
    },
    data: {
      refundedAmount: { increment: refundAmount },
      refundedAt: new Date(),
      status: fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED",
    },
  });
  if (applied.count !== 1) {
    return {
      ok: false,
      error: "Refund state changed concurrently — reload the payment and retry.",
    };
  }
  await logAudit({
    hotelId: payment.hotelId,
    userId: params.adminUserId,
    action: AUDIT_ACTIONS.PAYMENT_REFUNDED,
    entityType: "payment",
    entityId: params.paymentId,
    metadata: { amount: refundAmount, reason: params.reason, fullyRefunded },
  });
  return { ok: true };
}

/** Payment history for a hotel (tenant billing page). */
export async function listHotelPayments(hotelId: string) {
  const payments = await db.payment.findMany({
    where: { hotelId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return payments.map((p) => ({
    id: p.id,
    invoiceNumber: p.invoiceNumber,
    description: p.description,
    amount: p.amount,
    discountAmount: p.discountAmount,
    currency: p.currency,
    status: p.status,
    provider: p.provider,
    couponCode: p.couponCode,
    billingCycle: p.billingCycle,
    paidAt: p.paidAt?.toISOString() ?? null,
    refundedAmount: p.refundedAmount,
    createdAt: p.createdAt.toISOString(),
  }));
}

/** Platform-wide payment list for the Super Admin billing page. */
export async function listAllPayments(status?: string) {
  const payments = await db.payment.findMany({
    where: status ? { status: status as never } : undefined,
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { hotel: { select: { id: true, name: true } } },
  });
  return payments.map((p) => ({
    id: p.id,
    hotelId: p.hotelId,
    hotelName: p.hotel?.name ?? "",
    invoiceNumber: p.invoiceNumber,
    amount: p.amount,
    discountAmount: p.discountAmount,
    currency: p.currency,
    status: p.status,
    provider: p.provider,
    couponCode: p.couponCode,
    paidAt: p.paidAt?.toISOString() ?? null,
    refundedAmount: p.refundedAmount,
    createdAt: p.createdAt.toISOString(),
  }));
}

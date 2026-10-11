import { NextResponse } from "next/server";
import { readJson, jsonError, serverError, requireSuperAdminSession } from "@/lib/api-helpers";
import {
  getProviderSettings,
  saveProviderSettings,
  listAllPayments,
  markPaymentPaid,
  refundPayment,
  maskSecret,
  decryptPlatformSecret,
  encryptPlatformSecret,
  type ProviderConfig,
  type ProvidersSettings,
} from "@/lib/saas/billing";
import { logSecurityEvent } from "@/lib/saas/security";

/**
 * Billing centre — Phase 10 §6 (Super Admin only).
 *   GET  /api/super-admin/billing?payments=1   → provider configs (masked) + payments
 *   PUT  /api/super-admin/billing              → provider enable/disable/mode/secrets
 *   POST /api/super-admin/billing              → payment actions (confirm | refund)
 *
 * Secrets are AES-256-GCM encrypted at rest and NEVER returned — the API
 * only exposes masked hints + configuration status.
 */
function sanitizeProvider(provider: ProviderConfig): Record<string, unknown> {
  return {
    enabled: provider.enabled,
    mode: provider.mode,
    keyId: provider.keyId ? maskSecret(provider.keyId) : null,
    hasKeySecret: Boolean(provider.keySecretEnc),
    hasWebhookSecret: Boolean(provider.webhookSecretEnc),
    webhookUrl: provider.webhookUrl ?? null,
    configured: Boolean(
      provider.keySecretEnc || (provider.mode === "live" && provider.enabled === false),
    ),
  };
}

export async function GET(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const url = new URL(req.url);
    const providers = await getProviderSettings();
    const payments = url.searchParams.get("payments") === "1" ? await listAllPayments() : null;
    const revenue = payments
      ? {
          collected: payments
            .filter((p) => p.status === "PAID" || p.status === "PARTIALLY_REFUNDED")
            .reduce((s, p) => s + p.amount, 0),
          pending: payments.filter((p) => p.status === "PENDING").reduce((s, p) => s + p.amount, 0),
          refunded: payments
            .filter((p) => p.status === "REFUNDED" || p.status === "PARTIALLY_REFUNDED")
            .reduce((s, p) => s + (p.refundedAmount ?? 0), 0),
        }
      : null;
    return NextResponse.json({
      providers: {
        razorpay: sanitizeProvider(providers.razorpay),
        stripe: sanitizeProvider(providers.stripe),
        manual: { enabled: providers.manual.enabled, mode: providers.manual.mode },
      },
      payments,
      revenue,
    });
  } catch (err) {
    return serverError(err, "Could not load billing configuration.");
  }
}

export async function PUT(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const body = await readJson(req);
    const providerKey = typeof body?.provider === "string" ? body.provider : "";
    if (!["razorpay", "stripe", "manual"].includes(providerKey)) {
      return jsonError("Unknown billing provider.", 422, "VALIDATION_ERROR");
    }
    const current = await getProviderSettings();
    const provider: ProviderConfig = { ...current[providerKey as keyof ProvidersSettings] };
    if (body?.enabled !== undefined) provider.enabled = body.enabled === true;
    if (body?.mode === "test" || body?.mode === "live") provider.mode = body.mode;
    if (typeof body?.keyId === "string")
      provider.keyId = body.keyId.trim().slice(0, 200) || undefined;
    if (typeof body?.webhookUrl === "string")
      provider.webhookUrl = body.webhookUrl.trim().slice(0, 500) || undefined;
    // Secrets: accept ONLY on write (never read back). Empty string clears.
    if (typeof body?.keySecret === "string") {
      provider.keySecretEnc = body.keySecret.trim()
        ? encryptPlatformSecret(body.keySecret.trim(), providerKey)
        : undefined;
    }
    if (typeof body?.webhookSecret === "string") {
      provider.webhookSecretEnc = body.webhookSecret.trim()
        ? encryptPlatformSecret(body.webhookSecret.trim(), `${providerKey}-webhook`)
        : undefined;
    }
    const updated: ProvidersSettings = { ...current, [providerKey]: provider };
    await saveProviderSettings(updated, guard.session.userId, req);
    return NextResponse.json({ providers: { [providerKey]: sanitizeProvider(provider) } });
  } catch (err) {
    return serverError(err, "Could not update the billing provider.");
  }
}

export async function POST(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const body = await readJson(req);
    const action = typeof body?.action === "string" ? body.action : "";
    const paymentId = typeof body?.paymentId === "string" ? body.paymentId : "";
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!paymentId) return jsonError("paymentId is required.", 422, "VALIDATION_ERROR");

    if (action === "confirm") {
      if (reason.length < 3)
        return jsonError(
          "A reason is required to confirm a payment manually.",
          422,
          "REASON_REQUIRED",
        );
      const result = await markPaymentPaid({
        paymentId,
        provider: "manual",
        adminUserId: guard.session.userId,
        reason,
      });
      if (!result.ok)
        return jsonError(
          result.error ?? "Could not confirm payment.",
          400,
          "PAYMENT_CONFIRM_FAILED",
        );
      return NextResponse.json({ ok: true, alreadyPaid: result.alreadyPaid ?? false });
    }
    if (action === "refund") {
      if (reason.length < 3)
        return jsonError("A reason is required for refunds.", 422, "REASON_REQUIRED");
      const amount = body && Number.isFinite(Number(body.amount)) ? Number(body.amount) : undefined;
      const result = await refundPayment({
        paymentId,
        adminUserId: guard.session.userId,
        reason,
        amount,
      });
      if (!result.ok)
        return jsonError(result.error ?? "Could not refund payment.", 400, "REFUND_FAILED");
      await logSecurityEvent({
        type: "SUSPICIOUS_ACTIVITY",
        severity: "WARNING",
        userId: guard.session.userId,
        details: { action: "refund", paymentId, reason },
      });
      return NextResponse.json({ ok: true });
    }
    if (action === "test-webhook") {
      // Verify stored webhook secret decrypts correctly (configuration check).
      const providerKey = typeof body?.provider === "string" ? body.provider : "";
      const current = await getProviderSettings();
      const conf = current[providerKey as keyof ProvidersSettings];
      if (!conf?.webhookSecretEnc)
        return jsonError("No webhook secret configured.", 400, "NOT_CONFIGURED");
      try {
        decryptPlatformSecret(conf.webhookSecretEnc, `${providerKey}-webhook`);
        return NextResponse.json({ ok: true });
      } catch {
        return jsonError(
          "Stored webhook secret failed verification (key rotated?).",
          400,
          "DECRYPT_FAILED",
        );
      }
    }
    return jsonError("Unknown billing action.", 422, "VALIDATION_ERROR");
  } catch (err) {
    return serverError(err, "Could not perform the billing action.");
  }
}

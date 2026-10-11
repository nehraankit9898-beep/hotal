import { db } from "@/lib/db";
import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { decryptCredentials, isEncryptedEnvelope } from "@/lib/crypto";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { requestIp } from "@/lib/login-security";
import {
  verifyWhatsAppCredentials,
  verifyTwilioCredentials,
  verifyRazorpayCredentials,
  verifyStripeCredentials,
  type CredentialVerifyResult,
} from "@/lib/providers";

/**
 * POST /api/integrations/verify?id=<integrationId>
 *
 * AUDIT FIX (F04 — honest connection states): saving credentials alone no
 * longer claims "CONNECTED". This endpoint runs a REAL provider connectivity
 * check (read-only API call with the decrypted credentials) and moves the
 * integration to VERIFIED on success or ERROR (with lastError populated) on
 * failure. The UI can now show restaurants the difference between
 * "credentials saved" and "provider actually reachable".
 *
 * The verification detail is stored for the UI but NEVER contains secrets.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "INTEGRATION_MANAGE");
    if (denied) return denied;

    const id = new URL(req.url).searchParams.get("id");
    if (!id) return jsonError("Integration id is required.");

    const integration = await db.integration.findFirst({
      where: { id, hotelId: auth.user.hotelId },
    });
    if (!integration) return jsonError("Integration not found in your hotel.", 404, "NOT_FOUND");

    if (!integration.credentials || !isEncryptedEnvelope(integration.credentials)) {
      await db.integration.update({
        where: { id: integration.id },
        data: { status: "SAVED_UNVERIFIED", lastError: "No credentials saved yet." },
      });
      return jsonError("Save credentials before verifying the connection.", 400, "NO_CREDENTIALS");
    }

    let creds: Record<string, unknown>;
    try {
      creds = decryptCredentials(
        { hotelId: auth.user.hotelId, integrationType: integration.type },
        integration.credentials,
      ) as Record<string, unknown>;
    } catch {
      await db.integration.update({
        where: { id: integration.id },
        data: {
          status: "ERROR",
          lastError: "Credentials could not be decrypted (key material changed?). Re-save them.",
        },
      });
      return jsonError(
        "Credentials could not be decrypted. Please re-save them.",
        409,
        "DECRYPT_FAILED",
      );
    }

    const asString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
    let verdict: CredentialVerifyResult = {
      ok: false,
      detail: `No verifier for integration type ${integration.type}.`,
    };

    switch (integration.type) {
      case "WHATSAPP_CLOUD": {
        const token = asString(creds.token ?? creds.accessToken);
        const phoneNumberId = asString(creds.phoneNumberId ?? creds.phone_number_id);
        if (!token || !phoneNumberId) {
          verdict = {
            ok: false,
            detail: "Missing token or phoneNumberId in the saved credentials.",
          };
        } else {
          verdict = await verifyWhatsAppCredentials(token, phoneNumberId);
        }
        break;
      }
      case "TWILIO_SMS": {
        const sid = asString(creds.accountSid ?? creds.account_sid);
        const token = asString(creds.authToken ?? creds.auth_token);
        if (!sid || !token) {
          verdict = {
            ok: false,
            detail: "Missing accountSid or authToken in the saved credentials.",
          };
        } else {
          verdict = await verifyTwilioCredentials(sid, token);
        }
        break;
      }
      case "RAZORPAY": {
        const keyId = asString(creds.keyId ?? creds.key_id);
        const keySecret = asString(creds.keySecret ?? creds.key_secret);
        if (!keyId || !keySecret) {
          verdict = { ok: false, detail: "Missing keyId or keySecret in the saved credentials." };
        } else {
          verdict = await verifyRazorpayCredentials(keyId, keySecret);
        }
        break;
      }
      case "STRIPE": {
        const secretKey = asString(creds.secretKey ?? creds.secret_key);
        if (!secretKey) {
          verdict = { ok: false, detail: "Missing secretKey in the saved credentials." };
        } else {
          verdict = await verifyStripeCredentials(secretKey);
        }
        break;
      }
      default:
        // No live verifier for this type (SMTP/Zomato/POS/…). Honest answer:
        // the integration stays SAVED_UNVERIFIED — never auto-CONNECTED.
        verdict = {
          ok: false,
          detail: `Automated verification is not available for ${integration.type}; credentials are saved but unverified.`,
        };
        break;
    }

    const updated = await db.integration.update({
      where: { id: integration.id },
      data: {
        status: verdict.ok ? "VERIFIED" : "ERROR",
        lastError: verdict.ok ? null : (verdict.detail ?? "Verification failed.").slice(0, 500),
        lastSyncAt: verdict.ok ? new Date() : integration.lastSyncAt,
      },
    });

    await logAudit({
      req,
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: verdict.ok ? AUDIT_ACTIONS.INTEGRATION_UPDATED : AUDIT_ACTIONS.WEBHOOK_REJECTED,
      entityType: "integration",
      entityId: integration.id,
      metadata: { verify: true, ok: verdict.ok, detail: (verdict.detail ?? "").slice(0, 200) },
      ipAddress: requestIp(req),
    });

    return Response.json({
      ok: verdict.ok,
      providerId: verdict.providerId ?? null,
      detail: verdict.detail ?? null,
      integration: {
        id: updated.id,
        type: updated.type,
        status: updated.status,
        lastError: updated.lastError,
      },
    });
  } catch (err) {
    return serverError(err, "Connection verification failed.");
  }
}

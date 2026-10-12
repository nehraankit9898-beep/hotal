/**
 * Phase 18 — DIGITAL LOYALTY WALLET (pass records, honest provider status).
 *
 * WHAT THIS IS:
 *  - The tenant-scoped WALLET PASS RECORD system: issue/revoke/update loyalty
 *    passes bound to a customer, with guess-resistant serial numbers and an
 *    HMAC-signed update channel. The pass is a LOYALTY CREDENTIAL — it
 *    carries points/tier display only. It is NOT stored money, NOT a payment
 *    instrument, and nothing here touches payment settlement.
 *  - A generic pass payload renderer (JSON structure compatible with Apple
 *    Wallet pass.json / Google Wallet class-object shapes) that the real
 *    provider adapter will consume WHEN credentials exist.
 *
 * WHAT THIS HONESTLY IS NOT:
 *  - Actual Apple/Google signing + distribution requires developer
 *    certificates (Apple Pass Type ID + team keys / Google service account).
 *    Without them the API reports providerStatus = BLOCKED_PROVIDER_ACCESS —
 *    a PNG labelled "wallet integration" is explicitly forbidden by the
 *    phase prompt. The pass row + payload + revocation ARE real and testable
 *    today; the provider handshake is a documented, isolated adapter away.
 */

import { db } from "@/lib/db";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { getAISettings, logAIInteraction } from "@/lib/ai/governance";

export const WALLET_PROVIDER_STATUS = "BLOCKED_PROVIDER_ACCESS" as const;

export interface WalletPassView {
  /**
   * BUG FIX (API contract): the issue endpoint used to omit the row id while
   * `POST /api/wallet/passes/[id]/revoke` requires exactly that id, so a
   * client could not revoke the pass it had just issued without an extra
   * `GET /api/wallet/passes` round-trip (the integration test worked around
   * it by listing first). The id is now part of the view.
   */
  id: string;
  serialNumber: string;
  platform: string;
  status: string;
  pointsAtIssue: number;
  issuedAt: string;
  revokedAt: string | null;
  providerStatus: string;
  currentPoints?: number;
  currentTier?: string;
}

/** Issue (or return the existing) pass for a customer. Owner-initiated. */
export async function issuePass(
  hotelId: string,
  customerId: string,
  platform: "APPLE" | "GOOGLE" | "GENERIC" = "GENERIC",
): Promise<{ ok: true; pass: WalletPassView } | { ok: false; status: number; message: string }> {
  const settings = await getAISettings(hotelId);
  if (!settings.walletEnabled) {
    await logAIInteraction({
      hotelId, kind: "WALLET", subtype: "ISSUE", status: "BLOCKED_DISABLED",
      reason: "WALLET_DISABLED",
    });
    return { ok: false, status: 403, message: "Wallet passes are disabled for this tenant." };
  }

  const customer = await db.customer.findFirst({ where: { id: customerId, hotelId } });
  if (!customer) return { ok: false, status: 404, message: "Customer not found." };

  const loyalty = await db.loyaltyAccount.findUnique({
    where: { hotelId_customerId: { hotelId, customerId } },
  });

  const existing = await db.walletPass.findUnique({
    where: { hotelId_customerId_platform: { hotelId, customerId, platform } },
  });
  if (existing && existing.status === "ACTIVE") {
    return { ok: true, pass: toView(existing, loyalty?.points ?? 0, loyalty?.tier ?? "BRONZE") };
  }

  const serial = `RP-${randomBytes(12).toString("base64url")}`;
  const updateToken = randomBytes(24).toString("base64url");

  const pass = existing
    ? await db.walletPass.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", revokedAt: null, updateToken, pointsAtIssue: loyalty?.points ?? 0 },
      })
    : await db.walletPass.create({
        data: {
          hotelId, customerId, serialNumber: serial, platform,
          pointsAtIssue: loyalty?.points ?? 0, updateToken,
        },
      });

  await logAIInteraction({
    hotelId, kind: "WALLET", subtype: "ISSUE", status: "OK",
    customerId, meta: { platform, serialPrefix: serial.slice(0, 5), providerStatus: WALLET_PROVIDER_STATUS },
  });

  return { ok: true, pass: toView(pass, loyalty?.points ?? 0, loyalty?.tier ?? "BRONZE") };
}

export async function revokePass(
  hotelId: string,
  passId: string,
): Promise<boolean> {
  const updated = await db.walletPass.updateMany({
    where: { id: passId, hotelId, status: "ACTIVE" },
    data: { status: "REVOKED", revokedAt: new Date() },
  });
  if (updated.count === 1) {
    await logAIInteraction({ hotelId, kind: "WALLET", subtype: "REVOKE", status: "OK" });
  }
  return updated.count === 1;
}

/**
 * The generic pass payload (structure mirrors Apple pass.json / Google
 * object). Real distribution requires provider credentials (see header).
 */
export function renderPassPayload(
  pass: { serialNumber: string; platform: string; status: string; pointsAtIssue: number },
  hotel: { name: string; timezone?: string | null },
  loyalty: { points: number; tier: string },
): Record<string, unknown> {
  return {
    formatVersion: 1,
    passType: "storeCard", // loyalty card — NOT a payment pass
    serialNumber: pass.serialNumber,
    organizationName: hotel.name,
    description: `${hotel.name} loyalty card`,
    status: pass.status,
    loyaltyProgram: {
      points: loyalty.points,
      tier: loyalty.tier,
      // IMPORTANT: loyalty credential only — no stored value, no payment.
      storedValueSupported: false,
    },
    provider: {
      appleWallet: WALLET_PROVIDER_STATUS,
      googleWallet: WALLET_PROVIDER_STATUS,
      note: "Pass record is live; provider signing/distribution requires credentials.",
    },
  };
}

/** HMAC-signed proof for the pass update channel (revocable by revoking the pass). */
export function signPassUpdate(serial: string, token: string, authSecret: string): string {
  return createHmac("sha256", authSecret).update(`${serial}:${token}`).digest("base64url");
}

export function verifyPassUpdate(serial: string, token: string, signature: string, authSecret: string): boolean {
  const expected = signPassUpdate(serial, token, authSecret);
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function toView(
  row: { id: string; serialNumber: string; platform: string; status: string; pointsAtIssue: number; issuedAt: Date; revokedAt: Date | null },
  points: number,
  tier: string,
): WalletPassView {
  return {
    id: row.id,
    serialNumber: row.serialNumber,
    platform: row.platform,
    status: row.status,
    pointsAtIssue: row.pointsAtIssue,
    issuedAt: row.issuedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    providerStatus: WALLET_PROVIDER_STATUS,
    currentPoints: points,
    currentTier: tier,
  };
}

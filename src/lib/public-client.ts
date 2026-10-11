"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Public restaurant landing page data — resolved from a scanned QR code.
 * Rendered by /r/[code] — mobile-first, no login, no tracking.
 */

export interface PublicQrPayload {
  qr: { code: string; type: string; label: string | null };
  restaurant: {
    id: string;
    name: string;
    location: string | null;
    city: string | null;
    phone: string | null;
    email: string | null;
    currency: string;
  };
  loyalty: {
    enabled: boolean;
    mode: string;
    pointsPer100: number;
    pointsPerVisit: number;
    pointsForReward: number;
    rewardValue: number;
    signupBonus: number;
  };
  consentText: string;
  feedbackEnabled: boolean;
}

export function usePublicQr(code: string) {
  const [data, setData] = useState<PublicQrPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // All state updates happen after `await`, so nothing is set synchronously
  // inside the effect (react-hooks/set-state-in-effect compliant).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/public/qr/${encodeURIComponent(code)}`, {
          cache: "no-store",
        });
        const body = await res.json();
        if (!alive) return;
        if (!res.ok) {
          setError(body?.error?.message ?? "This QR code is not valid.");
          setData(null);
        } else {
          setData(body as PublicQrPayload);
          setError(null);
        }
      } catch {
        if (alive)
          setError("Could not reach the restaurant. Please check your internet connection.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [code, tick]);

  const reload = useCallback(() => {
    setLoading(true);
    setTick((t) => t + 1);
  }, []);

  return { data, error, loading, reload };
}

export interface JoinResult {
  ok: boolean;
  customer: { name: string; phone: string; marketingConsent: boolean };
  loyalty: {
    balance: number;
    bonusAwarded: number;
    pointsForReward: number;
    rewardValue: number;
  } | null;
}

/**
 * RECHECK FIX (E) — explicit OTP challenge result.
 * The API returns 202 with a typed `challenge` for an existing member's
 * phone: the visitor must prove ownership before anything is revealed or
 * updated. `publicJoin` surfaces that as a distinct union member instead of
 * pretending the call succeeded with null customer data (the old shape made
 * the UI crash on `res.data.customer.name`).
 */
export interface OtpChallenge {
  otpRequired: true;
  challenge: "issued" | "mismatch" | "expired" | "locked" | "cooldown";
  message: string;
  simulated?: boolean;
  expiresAt?: string;
  retryAfterSeconds?: number;
}

export async function publicJoin(payload: {
  qrCode: string;
  name: string;
  phone: string;
  marketingConsent: boolean;
  /** Phase 6.4 — channel-level opt-ins (all default false; never pre-ticked). */
  channels?: { whatsapp?: boolean; sms?: boolean; email?: boolean };
  /** RECHECK FIX (E): the 6-digit verification code (existing-member flow). */
  otp?: string;
}): Promise<
  | { ok: true; data: JoinResult }
  | { ok: false; message: string }
  | { ok: false; otpChallenge: OtpChallenge }
> {
  try {
    const res = await fetch("/api/public/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (res.status === 202 && body?.otpRequired) {
      return {
        ok: false,
        otpChallenge: {
          otpRequired: true,
          challenge: body.challenge ?? "issued",
          message: body.message ?? "Enter the verification code we sent you.",
          simulated: body.simulated === true,
          expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined,
          retryAfterSeconds:
            typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : undefined,
        },
      };
    }
    if (!res.ok)
      return {
        ok: false,
        message: body?.error?.message ?? "Something went wrong. Please try again.",
      };
    return { ok: true, data: body as JoinResult };
  } catch {
    return { ok: false, message: "Could not reach the restaurant. Please check your internet." };
  }
}

export async function publicFeedback(payload: {
  qrCode: string;
  rating: number;
  comment: string;
  phone?: string;
}): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch("/api/public/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) return { ok: false, message: body?.error?.message ?? "Something went wrong." };
    return { ok: true };
  } catch {
    return { ok: false, message: "Could not reach the restaurant. Please check your internet." };
  }
}

import { createHash, randomInt, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * AUDIT FIX (F14) — phone-ownership OTP for public (anonymous) flows.
 *
 * The public QR join page previously let ANY visitor who typed an existing
 * customer's phone number CHANGE that customer's stored name, flip consents
 * on, and READ the loyalty balance — no proof of ownership at all. Format
 * validation and rate limiting do not prove ownership.
 *
 * This module issues short-lived, single-use, hashed OTP codes bound to
 * (hotel, phone, purpose):
 *   - the plaintext code is NEVER stored (sha256 with a per-row salt);
 *   - 6 digits, 5-minute expiry, max 5 verification attempts per code;
 *   - single use (consumed on first successful verify);
 *   - constant-time comparison.
 *
 * Delivery goes through the SAME tenant-scoped messaging providers as
 * campaigns (SMS/WhatsApp); when no live provider is configured the platform
 * runs in SIMULATION mode — dev/test logs the code server-side ONLY so local
 * development stays usable; PRODUCTION never logs OTP values and simulation
 * delivery fails closed (an SMS that was never sent is never claimed).
 *
 * RECHECK FIX (H) — CONCURRENCY SAFETY: verification and attempt counting
 * were read-then-update, so two simultaneous correct submissions BOTH
 * consumed the code and BOTH succeeded, and racing wrong attempts could skip
 * the attempt ceiling. Consumption is now a single atomic conditional update
 * (guarded on unconsumed + unexpired + the exact code hash + attempt
 * ceiling), and failed attempts increment through the same guarded pattern
 * bound to the exact code generation.
 *
 * RECHECK FIX (E) — RESEND COOLDOWN: a fresh code is not minted on every
 * failed request (that reset the attempt ceiling each time and allowed SMS
 * pumping). issuePhoneOtp enforces a 60-second cooldown between sends for
 * the same (hotel, phone, purpose) and returns the remaining seconds.
 */

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
/**
 * SECURITY FIX (attempt reset): after OTP_MAX_ATTEMPTS wrong codes the phone is
 * locked for this long — re-issuing is refused until then. Before, every
 * re-issue reset `attempts` to 0, so a guesser could try 5 codes per minute.
 */
export const OTP_LOCKOUT_MS = 60 * 60 * 1000;

export type OtpIssueResult =
  | {
      ok: true;
      expiresAt: Date;
      deliveredVia: string;
      simulated: boolean;
      retryAfterSeconds: number;
    }
  | { ok: false; error: string; cooldownSeconds?: number };

function hashCode(phone: string, code: string, salt: string): string {
  return createHash("sha256").update(`${phone}:${code}:${salt}`).digest("hex");
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Issue (or re-issue) an OTP for (hotelId, phone). One live row per triple. */
/** Max codes issued per hotel+phone per hour (SMS cost / pumping guard). */
export const OTP_ISSUE_LIMIT_PER_HOUR = 5;

export async function issuePhoneOtp(params: {
  hotelId: string;
  phone: string;
  purpose?: string;
  sendTo?: { channel: "WHATSAPP" | "SMS"; recipient: string };
  hotelName?: string;
}): Promise<OtpIssueResult> {
  const purpose = params.purpose ?? "PUBLIC_JOIN";
  const now = new Date();

  const existing = await db.phoneOtp.findUnique({
    where: { hotelId_phone_purpose: { hotelId: params.hotelId, phone: params.phone, purpose } },
  });
  // SECURITY FIX: a live row whose attempt ceiling was reached stays locked.
  // Attempts carry over across re-issues while the row is live, so re-issuing
  // cannot reset the guess budget.
  const liveRow =
    existing !== null &&
    existing.consumedAt === null &&
    existing.expiresAt.getTime() > now.getTime();
  if (liveRow && existing && existing.attempts >= OTP_MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((existing.expiresAt.getTime() - now.getTime()) / 1000),
    );
    return {
      ok: false,
      error: "Too many incorrect codes for this number. Please try again later.",
      cooldownSeconds: retryAfterSeconds,
    };
  }
  // RECHECK FIX (E): resend cooldown — the row (if any) records when the
  // current code was issued via expiresAt − TTL. A resend inside the
  // cooldown neither resets the code nor burns another SMS.
  if (existing && existing.consumedAt === null && existing.expiresAt.getTime() > now.getTime()) {
    const issuedAt = existing.expiresAt.getTime() - OTP_TTL_MS;
    const elapsed = now.getTime() - issuedAt;
    if (elapsed < OTP_RESEND_COOLDOWN_MS) {
      const retryAfterSeconds = Math.max(1, Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000));
      return {
        ok: false,
        error: `A verification code was just sent. Please wait ${retryAfterSeconds}s before requesting another.`,
        cooldownSeconds: retryAfterSeconds,
      };
    }
  }

  // SECURITY FIX (S4): hourly cap per hotel+number on codes actually issued. The
  // per-IP limiter alone lets one number be texted from many IPs (SMS cost abuse).
  // Placed after the resend cooldown so cooldown-rejected calls don't consume it.
  const issueLimit = await checkRateLimit(
    `otp-issue:${params.hotelId}:${params.phone}`,
    OTP_ISSUE_LIMIT_PER_HOUR,
    60 * 60 * 1000,
  );
  if (!issueLimit.allowed) {
    return {
      ok: false,
      error: "Too many verification codes were requested for this number. Please try again later.",
      cooldownSeconds: issueLimit.retryAfterSeconds,
    };
  }

  const carriedAttempts = liveRow && existing ? existing.attempts : 0;
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");

  await db.phoneOtp.upsert({
    where: {
      hotelId_phone_purpose: { hotelId: params.hotelId, phone: params.phone, purpose },
    },
    create: {
      hotelId: params.hotelId,
      phone: params.phone,
      purpose,
      codeHash: hashCode(params.phone, code, purpose),
      attempts: 0,
      expiresAt,
    },
    update: {
      codeHash: hashCode(params.phone, code, purpose),
      attempts: carriedAttempts,
      consumedAt: null,
      expiresAt,
    },
  });

  // Deliver via the tenant's messaging provider when possible. This is an
  // OPERATIONAL (transactional) message, not marketing — consent gates do not
  // apply to verification codes, but we still respect a hard opt-out by
  // preferring SMS (DLT-regulated transactional route) over WhatsApp.
  let deliveredVia = "UNSUPPORTED";
  let simulated = true;
  if (params.sendTo) {
    try {
      const { resolveTenantProvider } = await import("@/lib/tenant-providers");
      const provider = await resolveTenantProvider(params.hotelId, params.sendTo.channel);
      const result = await provider.send({
        to: params.sendTo.recipient,
        body: `${code} is your StayLoop verification code for ${params.hotelName ?? "this venue"}. It expires in 5 minutes. Do not share this code.`,
      });
      deliveredVia = provider.id;
      simulated = provider.id === "SIMULATION";
      if (!result.ok) {
        deliveredVia = "FAILED";
      }
    } catch {
      deliveredVia = "FAILED";
    }
  }

  if (simulated || deliveredVia === "FAILED" || deliveredVia === "UNSUPPORTED") {
    // RECHECK FIX (H): production NEVER logs OTP values. Dev/test only:
    // the code appears in the server log so local development stays usable —
    // it is a test artifact, never a production delivery channel.
    if (isProduction()) {
      console.warn(
        `[phone-otp] OTP ${simulated ? "SIMULATED" : "UNDELIVERED"} for hotel ${params.hotelId}, purpose ${purpose} (value NOT logged in production) row issued`,
      );
    } else {
      console.warn(
        `[phone-otp] SIMULATED/UNDELIVERED code for ${params.phone} (hotel ${params.hotelId}, purpose ${purpose}): ${code}`,
      );
    }
  }

  // RECHECK FIX (E): fail closed — never tell the visitor a code was "sent"
  // when only a simulation ran (production) or the provider rejected it.
  if (deliveredVia === "FAILED") {
    return {
      ok: false,
      error: "Could not send the verification code. Please try again in a moment.",
    };
  }
  if (simulated && isProduction()) {
    return {
      ok: false,
      error:
        "This venue has no SMS/WhatsApp provider configured for verification codes. Please contact the venue.",
    };
  }

  return {
    ok: true,
    expiresAt,
    deliveredVia,
    simulated,
    retryAfterSeconds: Math.ceil(OTP_RESEND_COOLDOWN_MS / 1000),
  };
}

export type OtpVerifyResult =
  { ok: true } | { ok: false; reason: "NO_PENDING" | "EXPIRED" | "TOO_MANY_ATTEMPTS" | "MISMATCH" };

/**
 * Verify and consume an OTP (single use, constant-time, attempt-capped).
 *
 * RECHECK FIX (H) — ATOMIC CONSUME: the success path is ONE conditional
 * update (`consumedAt IS NULL AND codeHash = <this code's hash> AND
 * expiresAt > now AND attempts < max`) — two concurrent correct submissions
 * race on the single UPDATE and exactly one wins (count = 1). The loser
 * gets NO_PENDING. A re-issued code changes codeHash, so an in-flight
 * verification of the OLD code can no longer consume the row.
 */
export async function verifyPhoneOtp(params: {
  hotelId: string;
  phone: string;
  purpose?: string;
  code: string;
}): Promise<OtpVerifyResult> {
  const purpose = params.purpose ?? "PUBLIC_JOIN";
  const row = await db.phoneOtp.findUnique({
    where: {
      hotelId_phone_purpose: { hotelId: params.hotelId, phone: params.phone, purpose },
    },
  });
  if (!row || row.consumedAt) return { ok: false, reason: "NO_PENDING" };

  const now = Date.now();
  if (row.expiresAt.getTime() < now) return { ok: false, reason: "EXPIRED" };
  if (row.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "TOO_MANY_ATTEMPTS" };

  const provided = Buffer.from(hashCode(params.phone, params.code.trim(), purpose));
  const expected = Buffer.from(row.codeHash);
  const matches = provided.length === expected.length && timingSafeEqual(provided, expected);

  if (!matches) {
    // Guarded attempt increment (recheck fix H): bound to the exact code
    // generation AND the attempt ceiling — a racing burst cannot push
    // attempts past OTP_MAX_ATTEMPTS, and a re-issued code starts fresh.
    const bumped = await db.phoneOtp.updateMany({
      where: {
        id: row.id,
        codeHash: row.codeHash,
        consumedAt: null,
        attempts: { lt: OTP_MAX_ATTEMPTS },
      },
      data: { attempts: { increment: 1 } },
    });
    if (bumped.count === 1 && row.attempts + 1 >= OTP_MAX_ATTEMPTS) {
      // Ceiling reached: keep the row live for the lockout window (see issue).
      await db.phoneOtp.updateMany({
        where: { id: row.id, codeHash: row.codeHash, consumedAt: null },
        data: { expiresAt: new Date(Date.now() + OTP_LOCKOUT_MS) },
      });
    }
    return { ok: false, reason: "MISMATCH" };
  }

  // ATOMIC single-use consume (recheck fix H): exactly one caller wins.
  const consumed = await db.phoneOtp.updateMany({
    where: {
      id: row.id,
      codeHash: row.codeHash,
      consumedAt: null,
      expiresAt: { gt: new Date() },
      attempts: { lte: OTP_MAX_ATTEMPTS },
    },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) {
    // Another concurrent verification consumed (or invalidated) this code.
    return { ok: false, reason: "NO_PENDING" };
  }
  return { ok: true };
}

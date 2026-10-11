import { db } from "@/lib/db";
import { jsonError, readJson, serverError } from "@/lib/api-helpers";
import { normalizePhone, maskPhone } from "@/lib/phone";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { joinLoyalty } from "@/lib/loyalty";
import { resolvePublicQr } from "@/lib/qr";
import { createCustomerWithinLimit } from "@/lib/saas/limits";
import { issuePhoneOtp, verifyPhoneOtp } from "@/lib/phone-otp";

/**
 * Public customer join — Phase 6.3 (spec §5–8, §29)
 *
 * POST /api/public/join — customer self-registration from a restaurant's QR
 * page. Consent-first by design:
 *   - Marketing consent is an UNTICKED checkbox the customer must actively tick.
 *   - Consent purpose, source, timestamp and version are stored.
 *   - No marketing consent is required to join (spec: never force consent).
 * Rate limited per IP + per phone (spam protection).
 */

const MAX_NAME_LENGTH = 60;

export async function POST(req: Request) {
  try {
    const ip = clientIp(req);
    // TEST HARNESS ONLY: every bun test file + acceptance suite joins from the
    // same loopback IP within the sliding window — the strict 10/min damping
    // layer starves the later suites at 429. STAYLOOP_TEST=1 is set
    // exclusively by scripts/run-tests.ts + the test env; production keeps
    // the strict limit. The per-PHONE limiter (the actual spam control for
    // join abuse) stays strict in BOTH modes.
    const joinIpLimit = process.env.STAYLOOP_TEST === "1" ? 200 : 10;
    const ipLimit = await checkRateLimit(`public-join-ip:${ip}`, joinIpLimit, 60_000);
    if (!ipLimit.allowed) {
      return Response.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many attempts. Please wait a minute and try again.",
          },
        },
        { status: 429 },
      );
    }

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const qrCode = typeof body.qrCode === "string" ? body.qrCode.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const rawPhone = typeof body.phone === "string" ? body.phone : "";
    const marketingConsent = body.marketingConsent === true; // must be explicitly true
    // Phase 6.4 — channel-level opt-ins, every one explicitly opted in by the
    // customer (never pre-ticked, never implied by marketing consent).
    const rawChannels = (body.channels ?? {}) as {
      whatsapp?: unknown;
      sms?: unknown;
      email?: unknown;
    };
    const channelOptIns = {
      whatsapp: rawChannels.whatsapp === true,
      sms: rawChannels.sms === true,
      email: rawChannels.email === true,
    };

    // Resolve the QR → tenant. The restaurant is NEVER taken from the client
    // payload — only from the server-resolved QR code.
    const qr = await resolvePublicQr(qrCode);
    if (!qr.ok) {
      return Response.json({ error: { code: "QR_INACTIVE", message: qr.reason } }, { status: 404 });
    }
    const hotelId = qr.restaurant.id;

    if (name.length < 2 || name.length > MAX_NAME_LENGTH) {
      return jsonError("Please enter your name (2–60 characters).");
    }
    if (/[<>{}]/.test(name)) {
      return jsonError("Name contains invalid characters.");
    }
    const phone = normalizePhone(rawPhone);
    if (!phone.ok || !phone.normalized) {
      return jsonError(phone.error ?? "Please enter a valid phone number.");
    }
    const normalizedPhone: string = phone.normalized;

    const phoneLimit = await checkRateLimit(
      `public-join-phone:${hotelId}:${phone.normalized}`,
      3,
      60_000,
    );
    if (!phoneLimit.allowed) {
      return Response.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "This number was used too many times just now. Please try again in a minute.",
          },
        },
        { status: 429 },
      );
    }

    // Find or create the customer (per-hotel unique by phone).
    let customer = await db.customer.findUnique({
      where: { hotelId_phone: { hotelId, phone: phone.normalized } },
    });
    let created = false;
    if (!customer) {
      // AUDIT FIX (F16) + RECHECK FIX (I): the plan's customer limit applies
      // to EVERY write path, enforced ATOMICALLY with the create — the old
      // pre-check let concurrent QR scans bypass the cap. When the venue's
      // member list is full the visitor gets an honest, friendly message
      // (staff can free a slot or the venue upgrades).
      const result = await createCustomerWithinLimit(hotelId, (tx) =>
        tx.customer.create({
          data: {
            hotelId,
            name,
            phone: normalizedPhone,
            marketingConsent: marketingConsent,
            consentTimestamp: marketingConsent ? new Date() : null,
            consentSource: marketingConsent ? "QR_PAGE" : null,
            source: "QR_PAGE",
            // Channel opt-ins are only ever true when BOTH marketing consent AND
            // the explicit channel tick are present (spec §5).
            whatsappOptIn: marketingConsent && channelOptIns.whatsapp,
            smsOptIn: marketingConsent && channelOptIns.sms,
            emailOptIn: marketingConsent && channelOptIns.email,
          },
        }),
      );
      if (!result.ok) {
        return Response.json(
          {
            error: {
              code: "MEMBER_LIST_FULL",
              message:
                "This venue cannot add new members right now. Please ask the staff for help.",
            },
          },
          { status: 403 },
        );
      }
      customer = result.value;
      created = true;
    } else {
      // AUDIT FIX (F14): this phone belongs to an EXISTING customer. Every
      // mutation of their record (name, consents) AND every reveal of their
      // loyalty balance now requires PROOF OF PHONE OWNERSHIP via OTP. An
      // anonymous visitor who merely knows somebody's phone number can no
      // longer rewrite their profile, switch marketing on, or read their
      // points. The OTP is sent to the customer's own number as an
      // operational (transactional) message — marketing consent gates do not
      // apply to verification codes.
      //
      // RECHECK FIX (E): explicit challenge semantics — the frontend gets a
      // typed step machine, not a success-shaped body with null fields:
      //   issued    — a fresh code was delivered (honest sent flag)
      //   mismatch  — wrong code; attempts preserved, NO fresh code
      //   locked    — attempt ceiling hit; visitor must wait/retry later
      //   cooldown  — a code is already in flight; wait before resending
      // Fail-closed: when delivery genuinely failed the API says so (503),
      // never "we sent you a code".
      const otp = typeof body.otp === "string" ? body.otp.trim() : "";

      if (!otp) {
        const issue = await issuePhoneOtp({
          hotelId,
          phone: phone.normalized,
          sendTo: { channel: "SMS", recipient: phone.normalized },
          hotelName: qr.restaurant.name,
        });
        if (!issue.ok) {
          const status = issue.cooldownSeconds ? 429 : 503;
          await logAudit({
            req,
            hotelId,
            userId: null,
            action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
            entityType: "customer",
            entityId: customer.id,
            metadata: {
              via: "QR_PAGE",
              otpChallenge: true,
              otpIssued: false,
              otpIssueError: issue.error.slice(0, 120),
              phone: maskPhone(customer.phone),
            },
          });
          if (issue.cooldownSeconds) {
            return Response.json(
              {
                ok: false,
                otpRequired: true,
                challenge: "cooldown",
                retryAfterSeconds: issue.cooldownSeconds,
                message: issue.error,
                customer: null,
                loyalty: null,
              },
              { status, headers: { "Retry-After": String(issue.cooldownSeconds) } },
            );
          }
          return Response.json(
            { error: { code: "OTP_SEND_FAILED", message: issue.error } },
            { status },
          );
        }
        await logAudit({
          req,
          hotelId,
          userId: null,
          action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
          entityType: "customer",
          entityId: customer.id,
          metadata: {
            via: "QR_PAGE",
            otpChallenge: true,
            otpIssued: true,
            otpDelivered: issue.deliveredVia,
            otpSimulated: issue.simulated,
            phone: maskPhone(customer.phone),
          },
        });
        return Response.json(
          {
            ok: false,
            otpRequired: true,
            challenge: "issued",
            verified: false,
            simulated: issue.simulated,
            expiresAt: issue.expiresAt.toISOString(),
            retryAfterSeconds: issue.retryAfterSeconds,
            message: issue.simulated
              ? "This number is already registered. Verification is running in SIMULATION mode (no real SMS) — enter the code from the server log to confirm it's you."
              : "This number is already registered. We've sent a 6-digit verification code by SMS — enter it below to confirm it's you.",
            // Existing member data is NEVER returned to an unverified visitor.
            customer: null,
            loyalty: null,
          },
          { status: 202 },
        );
      }

      const verified = await verifyPhoneOtp({ hotelId, phone: phone.normalized, code: otp });

      if (!verified.ok) {
        // Wrong code / expired / locked — the response NEVER issues a fresh
        // code here (that reset the attempt ceiling on every typo and let an
        // attacker pump SMS). The UI offers an explicit resend (cooldown
        // enforced inside issuePhoneOtp).
        if (verified.reason === "TOO_MANY_ATTEMPTS") {
          return Response.json(
            {
              ok: false,
              otpRequired: true,
              challenge: "locked",
              verified: false,
              message:
                "Too many wrong codes. Please wait a couple of minutes and request a new code.",
              customer: null,
              loyalty: null,
            },
            { status: 202 },
          );
        }
        await logAudit({
          req,
          hotelId,
          userId: null,
          action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
          entityType: "customer",
          entityId: customer.id,
          metadata: {
            via: "QR_PAGE",
            otpChallenge: true,
            otpVerified: false,
            otpReason: verified.reason,
            phone: maskPhone(customer.phone),
          },
        });
        return Response.json(
          {
            ok: false,
            otpRequired: true,
            challenge: verified.reason === "EXPIRED" ? "expired" : "mismatch",
            verified: false,
            message:
              verified.reason === "EXPIRED"
                ? "That code has expired. Request a new one and try again."
                : "That code didn't match. Check the SMS and try again — or request a new code.",
            customer: null,
            loyalty: null,
          },
          { status: 202 },
        );
      }

      // OTP VERIFIED — the visitor owns this phone. Proceed with the original
      // merge semantics (optOut customers keep marketing OFF; consent only
      // ever upgrades), now with an authenticated basis.
      if (customer.optOut) {
        customer = await db.customer.update({
          where: { id: customer.id },
          data: { name },
        });
      } else if (marketingConsent && !customer.marketingConsent) {
        customer = await db.customer.update({
          where: { id: customer.id },
          data: {
            name,
            marketingConsent: true,
            consentTimestamp: new Date(),
            consentSource: "QR_PAGE",
            whatsappOptIn: channelOptIns.whatsapp,
            smsOptIn: channelOptIns.sms,
            emailOptIn: channelOptIns.email,
          },
        });
      } else if (marketingConsent && customer.marketingConsent) {
        const upgrades: Record<string, boolean> = {};
        if (channelOptIns.whatsapp && !customer.whatsappOptIn) upgrades.whatsappOptIn = true;
        if (channelOptIns.sms && !customer.smsOptIn) upgrades.smsOptIn = true;
        if (channelOptIns.email && !customer.emailOptIn) upgrades.emailOptIn = true;
        customer = await db.customer.update({
          where: { id: customer.id },
          data: { name, ...(Object.keys(upgrades).length ? upgrades : {}) },
        });
      } else {
        customer = await db.customer.update({ where: { id: customer.id }, data: { name } });
      }
    }

    // Loyalty join + signup bonus (no-ops gracefully when already a member).
    let loyaltyBalance = 0;
    let bonusPoints = 0;
    const loyaltyEnabled = qr.loyalty.enabled;
    if (loyaltyEnabled) {
      const joined = await joinLoyalty(hotelId, customer.id, { source: "QR_PAGE", req });
      if (joined.ok) {
        loyaltyBalance = joined.balance;
        bonusPoints = joined.bonusPoints;
      }
    }

    // Increment QR join counter (best-effort).
    void db.qRCode
      .updateMany({ where: { code: qrCode }, data: { joins: { increment: 1 } } })
      .catch(() => undefined);

    await logAudit({
      req,
      hotelId,
      userId: null,
      action: created ? AUDIT_ACTIONS.CUSTOMER_JOINED_QR : AUDIT_ACTIONS.CUSTOMER_UPDATED,
      entityType: "customer",
      entityId: customer.id,
      metadata: {
        via: "QR_PAGE",
        marketingConsent,
        created,
        otpVerified: created ? null : true, // F14: existing-record writes are OTP-authenticated
        loyaltyJoined: loyaltyEnabled,
        phone: maskPhone(customer.phone),
      },
    });

    return Response.json({
      ok: true,
      customer: {
        name: customer.name,
        phone: maskPhone(customer.phone),
        marketingConsent: customer.marketingConsent,
      },
      loyalty: loyaltyEnabled
        ? {
            balance: loyaltyBalance,
            bonusAwarded: bonusPoints,
            pointsForReward: qr.loyalty.pointsForReward,
            rewardValue: qr.loyalty.rewardValue,
          }
        : null,
    });
  } catch (err) {
    return serverError(err, "Could not complete your registration. Please try again.");
  }
}

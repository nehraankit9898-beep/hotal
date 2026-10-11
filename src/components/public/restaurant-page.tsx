"use client";

import { useEffect, useState } from "react";
import { publicJoin, publicFeedback, usePublicQr, type PublicQrPayload } from "@/lib/public-client";

/**
 * Customer-facing restaurant page — Phase 6.3 (spec §29)
 *
 * Mobile-first by design: most customers scan a QR with their phone.
 * Consent rules (spec §6):
 *   - The marketing checkbox is UNTICKED by default and clearly separate.
 *   - Joining (basic profile) never requires marketing consent.
 *   - The page explains in plain words what the customer gets.
 * No dark patterns: honest labels, no pre-selection, no hiding.
 */

const stars = (n: number) => "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n);

export function PublicRestaurantClient({ code }: { code: string }) {
  const { data, error, loading } = usePublicQr(code);
  const [tab, setTab] = useState<"join" | "feedback">("join");

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-orange-50 via-background to-background dark:from-orange-950/20">
      <div className="mx-auto w-full max-w-md px-4 py-8 flex-1">
        {loading ? (
          <div className="flex flex-col items-center justify-center gap-4 py-24">
            <div className="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">Loading restaurant page…</p>
          </div>
        ) : error || !data ? (
          <div className="rounded-2xl border bg-card p-8 text-center shadow-sm mt-16">
            <p className="text-4xl">😕</p>
            <h1 className="mt-3 text-lg font-bold">Page not available</h1>
            <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            <p className="mt-4 text-xs text-muted-foreground">
              Please ask the restaurant staff for help or scan the QR code again.
            </p>
          </div>
        ) : (
          <>
            {/* Restaurant header */}
            <div className="text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-2xl text-primary-foreground shadow">
                🍽️
              </div>
              <h1 className="mt-4 text-2xl font-extrabold tracking-tight">
                {data.restaurant.name}
              </h1>
              {data.restaurant.location || data.restaurant.city ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  {[data.restaurant.location, data.restaurant.city].filter(Boolean).join(", ")}
                </p>
              ) : null}
              {data.qr.label ? (
                <p className="mt-2 inline-block rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                  {data.qr.label}
                </p>
              ) : null}
            </div>

            {/* Tabs */}
            <div className="mt-6 grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
              <button
                type="button"
                onClick={() => setTab("join")}
                className={`rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                  tab === "join" ? "bg-background shadow text-foreground" : "text-muted-foreground"
                }`}
              >
                Join Rewards
              </button>
              {data.feedbackEnabled ? (
                <button
                  type="button"
                  onClick={() => setTab("feedback")}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                    tab === "feedback"
                      ? "bg-background shadow text-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  Give Feedback
                </button>
              ) : (
                <span className="rounded-lg px-3 py-2 text-sm font-semibold text-muted-foreground/50">
                  Feedback off
                </span>
              )}
            </div>

            <div className="mt-4">
              {tab === "join" ? <JoinPanel data={data} /> : <FeedbackPanel data={data} />}
            </div>

            <p className="mt-8 text-center text-[11px] leading-relaxed text-muted-foreground">
              Powered by StayLoop · Your data belongs to {data.restaurant.name} only — it is never
              sold or shared. You can stop messages anytime.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function JoinPanel({ data }: { data: PublicQrPayload }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [marketing, setMarketing] = useState(false); // UNTICKED by default (spec §6)
  // Phase 6.4 — channel-level opt-ins (unticked by default, only shown with consent)
  const [optWhatsapp, setOptWhatsapp] = useState(false);
  const [optSms, setOptSms] = useState(false);
  const [optEmail, setOptEmail] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    name: string;
    loyalty: {
      balance: number;
      bonusAwarded: number;
      pointsForReward: number;
      rewardValue: number;
    } | null;
    marketingConsent: boolean;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // RECHECK FIX (E) — existing-member OTP step (proof of phone ownership).
  // No OTP state → the normal join form. A challenge switches the panel to a
  // 6-digit code entry with an honest resend (cooldown counted down client-
  // side, enforced again server-side).
  const [otpStep, setOtpStep] = useState<{
    message: string;
    simulated: boolean;
    resendAfter: number;
    locked: boolean;
  } | null>(null);
  const [otp, setOtp] = useState("");

  // Countdown tick for the resend cooldown. (Called unconditionally — before
  // the early return — so hook order stays stable across renders.)
  const resendAfter = otpStep?.resendAfter ?? 0;
  useEffect(() => {
    if (resendAfter <= 0) return;
    const t = setInterval(() => {
      setOtpStep((prev) =>
        prev ? { ...prev, resendAfter: Math.max(0, prev.resendAfter - 1) } : prev,
      );
    }, 1000);
    return () => clearInterval(t);
  }, [resendAfter]);

  if (!data) return null;
  const loy = data.loyalty;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    const res = await publicJoin({
      qrCode: data.qr.code,
      name,
      phone,
      marketingConsent: marketing,
      channels: { whatsapp: optWhatsapp, sms: optSms, email: optEmail },
      ...(otpStep ? { otp } : {}),
    });
    setSubmitting(false);
    if ("otpChallenge" in res) {
      const c = res.otpChallenge;
      if (c.challenge === "cooldown") {
        setErr(c.message);
        if (c.retryAfterSeconds) {
          setOtpStep((prev) => (prev ? { ...prev, resendAfter: c.retryAfterSeconds! } : prev));
        }
        return;
      }
      setOtp("");
      setOtpStep({
        message: c.message,
        simulated: c.simulated ?? false,
        resendAfter: c.challenge === "issued" ? (c.retryAfterSeconds ?? 60) : 0,
        locked: c.challenge === "locked",
      });
      return;
    }
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setResult({
      name: res.data.customer.name,
      loyalty: res.data.loyalty,
      marketingConsent: res.data.customer.marketingConsent,
    });
  }

  // RECHECK FIX (E) — existing-member OTP step: the panel switches from the
  // join form to a focused 6-digit verification view. Nothing about the
  // existing member is shown until the code is accepted.
  if (otpStep) {
    return (
      <form onSubmit={submit} className="rounded-2xl border bg-card p-5 shadow-sm">
        <div className="text-center">
          <p className="text-3xl">🔐</p>
          <h2 className="mt-2 text-lg font-bold">Verify it&apos;s you</h2>
          <p className="mt-2 text-sm text-muted-foreground">{otpStep.message}</p>
          {otpStep.simulated ? (
            <p className="mt-2 inline-block rounded-full bg-amber-500/10 px-3 py-1 text-[11px] font-medium text-amber-600">
              Simulation mode — no real SMS was sent
            </p>
          ) : null}
        </div>
        <label className="mt-5 block text-sm font-medium" htmlFor="pj-otp">
          6-digit verification code
        </label>
        <input
          id="pj-otp"
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="••••••"
          className="mt-1 w-full rounded-lg border bg-background px-3 py-2.5 text-center text-xl font-mono tracking-[0.4em] outline-none focus:ring-2 focus:ring-primary"
        />
        {err ? (
          <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {err}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={submitting || otp.length < 6}
          className="mt-4 w-full rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground shadow transition hover:opacity-90 disabled:opacity-60"
        >
          {submitting ? "Verifying…" : "Verify and continue"}
        </button>
        <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => {
              setOtpStep(null);
              setOtp("");
              setErr(null);
            }}
          >
            Use a different number
          </button>
          <button
            type="button"
            disabled={otpStep.locked || otpStep.resendAfter > 0 || submitting}
            onClick={() => {
              // Re-request the code (server enforces the cooldown again).
              void (async () => {
                setErr(null);
                setSubmitting(true);
                const res = await publicJoin({
                  qrCode: data.qr.code,
                  name,
                  phone,
                  marketingConsent: marketing,
                  channels: { whatsapp: optWhatsapp, sms: optSms, email: optEmail },
                });
                setSubmitting(false);
                if ("otpChallenge" in res) {
                  const c = res.otpChallenge;
                  if (c.challenge === "cooldown") {
                    setErr(c.message);
                    if (c.retryAfterSeconds) {
                      setOtpStep((prev) =>
                        prev ? { ...prev, resendAfter: c.retryAfterSeconds! } : prev,
                      );
                    }
                    return;
                  }
                  setOtp("");
                  setOtpStep({
                    message: c.message,
                    simulated: c.simulated ?? false,
                    resendAfter: c.retryAfterSeconds ?? 60,
                    locked: c.challenge === "locked",
                  });
                  return;
                }
                setErr(res.ok ? "Code sent again." : res.message);
              })();
            }}
            className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
          >
            {otpStep.locked
              ? "Wait before retrying"
              : otpStep.resendAfter > 0
                ? `Resend code in ${otpStep.resendAfter}s`
                : "Resend code"}
          </button>
        </div>
      </form>
    );
  }

  if (result) {
    return (
      <div className="rounded-2xl border bg-card p-6 text-center shadow-sm">
        <p className="text-4xl">🎉</p>
        <h2 className="mt-3 text-lg font-bold">You're in, {result.name}!</h2>
        {result.loyalty ? (
          <>
            <div className="mt-4 rounded-xl bg-primary/5 p-4">
              <p className="text-sm text-muted-foreground">Your reward points</p>
              <p className="text-3xl font-extrabold text-primary">{result.loyalty.balance}</p>
              {result.loyalty.bonusAwarded > 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Includes {result.loyalty.bonusAwarded} welcome points 🎁
                </p>
              ) : null}
              <p className="mt-2 text-xs text-muted-foreground">
                {result.loyalty.pointsForReward} points = ₹{result.loyalty.rewardValue} reward
              </p>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Show your phone number on your next visit to earn and use points.
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">You're on the guest list.</p>
        )}
        {result.marketingConsent ? (
          <p className="mt-3 text-xs text-muted-foreground">
            ✅ You'll receive offers from {data.restaurant.name}. You can stop them anytime.
          </p>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            You joined without marketing messages — that's completely fine. You can opt in anytime
            at the counter.
          </p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border bg-card p-5 shadow-sm">
      {loy.enabled ? (
        <div className="mb-4 rounded-xl bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground">Earn rewards:</span>{" "}
          {loy.mode === "POINTS"
            ? `Every ₹100 you spend = ${loy.pointsPer100} points. `
            : `Each visit = ${loy.pointsPerVisit} points. `}
          {loy.pointsForReward} points = ₹{loy.rewardValue} reward.
          {loy.signupBonus > 0 ? ` Join now and get ${loy.signupBonus} bonus points!` : ""}
        </div>
      ) : (
        <div className="mb-4 rounded-xl bg-muted p-3 text-xs text-muted-foreground">
          Join our guest list to stay connected with the restaurant.
        </div>
      )}

      <label className="block text-sm font-medium" htmlFor="pj-name">
        Your name
      </label>
      <input
        id="pj-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={60}
        autoComplete="name"
        placeholder="e.g. Priya Sharma"
        className="mt-1 w-full rounded-lg border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary"
      />

      <label className="mt-4 block text-sm font-medium" htmlFor="pj-phone">
        Phone number
      </label>
      <input
        id="pj-phone"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        required
        inputMode="tel"
        autoComplete="tel"
        placeholder="e.g. 98765 43210"
        className="mt-1 w-full rounded-lg border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary"
      />

      {/* Consent — separate, clear, never pre-ticked (spec §6) */}
      <label
        htmlFor="pj-consent"
        className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm"
      >
        <input
          id="pj-consent"
          type="checkbox"
          checked={marketing}
          onChange={(e) => setMarketing(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-primary"
        />
        <span>
          {data.consentText}
          <span className="mt-1 block text-xs text-muted-foreground">
            Optional — you can join without this. We'll only send restaurant news and offers, never
            spam, and you can unsubscribe anytime.
          </span>
        </span>
      </label>

      {marketing ? (
        <div className="mt-3 space-y-2 rounded-lg border bg-muted/30 p-3">
          <p className="text-xs font-medium text-muted-foreground">
            How may we send you offers? (choose what you like)
          </p>
          {[
            { id: "pj-ch-wa", label: "WhatsApp", checked: optWhatsapp, set: setOptWhatsapp },
            { id: "pj-ch-sms", label: "SMS", checked: optSms, set: setOptSms },
            { id: "pj-ch-email", label: "Email", checked: optEmail, set: setOptEmail },
          ].map((ch) => (
            <label
              key={ch.id}
              htmlFor={ch.id}
              className="flex cursor-pointer items-center gap-2.5 text-sm"
            >
              <input
                id={ch.id}
                type="checkbox"
                checked={ch.checked}
                onChange={(e) => ch.set(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              {ch.label}
            </label>
          ))}
          <p className="text-[11px] text-muted-foreground">
            Each channel is separate — you choose exactly how we contact you. You can change this
            anytime.
          </p>
        </div>
      ) : null}

      {err ? (
        <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {err}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitting}
        className="mt-5 w-full rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground shadow transition hover:opacity-90 disabled:opacity-60"
      >
        {submitting ? "Joining…" : loy.enabled ? "Join Rewards" : "Join Guest List"}
      </button>
      <p className="mt-3 text-center text-[11px] text-muted-foreground">
        By joining you agree that {data.restaurant.name} can keep your name and phone number to
        recognise your visits.
      </p>
    </form>
  );
}

function FeedbackPanel({ data }: { data: PublicQrPayload }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (rating < 1) {
      setErr("Please tap a star rating first.");
      return;
    }
    setErr(null);
    setSubmitting(true);
    const res = await publicFeedback({
      qrCode: data.qr.code,
      rating,
      comment,
      phone: phone || undefined,
    });
    setSubmitting(false);
    if (!res.ok) {
      setErr(res.message ?? "Could not send feedback.");
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div className="rounded-2xl border bg-card p-8 text-center shadow-sm">
        <p className="text-4xl">🙏</p>
        <h2 className="mt-3 text-lg font-bold">Thank you!</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Your feedback goes straight to {data.restaurant.name}.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border bg-card p-5 shadow-sm">
      <p className="text-center text-sm font-medium">How was your experience?</p>
      <div className="mt-3 flex justify-center gap-2" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
            onClick={() => setRating(n)}
            className={`rounded-lg px-2 py-1 text-3xl transition-transform hover:scale-110 ${
              n <= rating ? "text-amber-500" : "text-muted-foreground/30"
            }`}
          >
            {n <= rating ? "★" : "☆"}
          </button>
        ))}
      </div>
      <p className="mt-1 text-center text-xs text-muted-foreground">
        {rating >= 1 ? `${stars(rating)} selected` : "Tap to rate"}
      </p>

      <label className="mt-4 block text-sm font-medium" htmlFor="pf-comment">
        Tell us more <span className="font-normal text-muted-foreground">(optional)</span>
      </label>
      <textarea
        id="pf-comment"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={500}
        rows={3}
        placeholder="What did you like? What can we improve?"
        className="mt-1 w-full rounded-lg border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary"
      />

      <label className="mt-3 block text-sm font-medium" htmlFor="pf-phone">
        Your phone{" "}
        <span className="font-normal text-muted-foreground">
          (optional — links feedback to your visits)
        </span>
      </label>
      <input
        id="pf-phone"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        inputMode="tel"
        placeholder="e.g. 98765 43210"
        className="mt-1 w-full rounded-lg border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary"
      />

      {err ? (
        <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {err}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitting}
        className="mt-5 w-full rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground shadow transition hover:opacity-90 disabled:opacity-60"
      >
        {submitting ? "Sending…" : "Send Feedback"}
      </button>
    </form>
  );
}

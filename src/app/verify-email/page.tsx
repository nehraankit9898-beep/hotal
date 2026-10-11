"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

/**
 * Phase 7 — public email verification page. Consumes ?token=… from the emailed
 * link and calls POST /api/auth/verify-email. No account data is displayed.
 */
function VerifyEmailInner() {
  const params = useSearchParams();
  const token = params.get("token");
  // Derived initial state — no setState inside the effect body.
  const [state, setState] = useState<"working" | "ok" | "error">(token ? "working" : "error");
  const [message, setMessage] = useState(() =>
    token
      ? "Verifying your email address…"
      : "This verification link is missing its token. Please use the link from your email.",
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { message?: string; ok?: boolean };
        if (cancelled) return;
        if (res.ok && data.ok) {
          setState("ok");
          setMessage(data.message || "Your email address has been verified.");
        } else {
          setState("error");
          setMessage(data.message || "We could not verify your email.");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setState("error");
        setMessage("Network error — please try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-neutral-50 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-sm border border-neutral-200 p-8 text-center">
        <div className="text-2xl font-bold tracking-tight mb-2">StayLoop</div>
        <div
          className={
            "inline-block rounded-full px-4 py-2 text-sm font-medium " +
            (state === "ok"
              ? "bg-emerald-100 text-emerald-800"
              : state === "error"
                ? "bg-red-100 text-red-800"
                : "bg-neutral-100 text-neutral-700")
          }
        >
          {message}
        </div>
        {state !== "working" && (
          <a
            href="/"
            className="mt-6 inline-block text-sm font-medium underline underline-offset-4"
          >
            Go to sign in
          </a>
        )}
      </div>
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<main className="min-h-screen" />}>
      <VerifyEmailInner />
    </Suspense>
  );
}

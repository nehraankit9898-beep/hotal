"use client";

import { useState } from "react";

/**
 * Phase 7 — public forgot-password page. Posts the email to
 * /api/auth/forgot-password. The response is always generic
 * (anti-enumeration) — this page mirrors that honestly.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (res.ok && data.ok) {
        setSent(true);
      } else {
        setError(data.message || "Something went wrong. Please try again.");
      }
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-neutral-50 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-sm border border-neutral-200 p-8">
        <div className="text-2xl font-bold tracking-tight mb-1">StayLoop</div>
        <h1 className="text-lg font-semibold mb-4">Reset your password</h1>

        {sent ? (
          <p className="text-sm text-neutral-600 leading-relaxed">
            If an account exists for that email, a password reset link has been sent. Please check
            your inbox (and spam folder). The link expires in one hour.
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium mb-1">
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900"
                placeholder="you@example.com"
              />
            </div>
            {error && <p className="text-sm text-red-700">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-neutral-900 text-white py-2.5 text-sm font-semibold hover:bg-neutral-800 disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send reset link"}
            </button>
            <a
              href="/"
              className="block text-center text-sm underline underline-offset-4 text-neutral-600"
            >
              Back to sign in
            </a>
          </form>
        )}
      </div>
    </main>
  );
}

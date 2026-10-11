"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Phase 7 — public password reset page. Consumes ?token=… from the emailed
 * link, collects a new password, and calls POST /api/auth/reset-password.
 * On success every previous session is revoked server-side.
 */
function ResetPasswordInner() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [state, setState] = useState<"form" | "done">("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (res.ok && data.ok) {
        setState("done");
      } else {
        setError(data.message || "We could not reset your password.");
      }
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900";

  return (
    <main className="min-h-screen flex items-center justify-center bg-neutral-50 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-sm border border-neutral-200 p-8">
        <div className="text-2xl font-bold tracking-tight mb-1">StayLoop</div>
        <h1 className="text-lg font-semibold mb-4">Choose a new password</h1>

        {!token ? (
          <p className="text-sm text-red-700">
            This reset link is missing its token. Please use the link from your email, or request a
            new one from the{" "}
            <a href="/forgot-password" className="underline underline-offset-4">
              forgot password
            </a>{" "}
            page.
          </p>
        ) : state === "done" ? (
          <div className="space-y-4">
            <p className="text-sm text-emerald-800 bg-emerald-100 rounded-lg px-4 py-3">
              Your password has been reset. All previous sessions were signed out.
            </p>
            <a
              href="/"
              className="block text-center text-sm font-medium underline underline-offset-4"
            >
              Go to sign in
            </a>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label htmlFor="password" className="block text-sm font-medium mb-1">
                New password
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
              />
              <p className="mt-1 text-xs text-neutral-500">
                At least 8 characters, with letters and numbers.
              </p>
            </div>
            <div>
              <label htmlFor="confirm" className="block text-sm font-medium mb-1">
                Confirm new password
              </label>
              <input
                id="confirm"
                type="password"
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className={inputClass}
              />
            </div>
            {error && <p className="text-sm text-red-700">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-neutral-900 text-white py-2.5 text-sm font-semibold hover:bg-neutral-800 disabled:opacity-50"
            >
              {busy ? "Resetting…" : "Reset password"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<main className="min-h-screen" />}>
      <ResetPasswordInner />
    </Suspense>
  );
}

"use client";

import { use, useEffect, useState } from "react";

const rupees = (minor: number, currency: string) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(minor / 100);

/**
 * Phase 15 — public payment link page /pay/[token].
 * Exposes ONLY the amount + restaurant name for this token. Payment happens
 * through the gateway when configured; the page never exposes other bills or
 * customer data and cannot mark anything paid by itself.
 */
export default function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [state, setState] = useState<{
    loading: boolean;
    error?: string;
    data?: { status: string; restaurantName: string; amountMinor?: number; currency?: string; billNumber?: string };
  }>({ loading: true });

  useEffect(() => {
    fetch(`/api/pay/${token}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.error?.message ?? "This payment link is not valid.");
        setState({ loading: false, data: body });
      })
      .catch((err: Error) => setState({ loading: false, error: err.message }));
  }, [token]);

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-zinc-50 dark:bg-zinc-950 p-6">
      <div className="w-full max-w-sm rounded-2xl border bg-card shadow-sm p-6 text-center space-y-3">
        {state.loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : state.error ? (
          <>
            <h1 className="text-lg font-bold">Link unavailable</h1>
            <p className="text-sm text-muted-foreground">{state.error}</p>
          </>
        ) : state.data && state.data.amountMinor != null ? (
          <>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{state.data.restaurantName}</p>
            <div className="text-3xl font-bold">{rupees(state.data.amountMinor, state.data.currency ?? "INR")}</div>
            {state.data.billNumber && <p className="text-xs text-muted-foreground">Bill {state.data.billNumber}</p>}
            <a
              href={`/api/pay/${token}/checkout`}
              className="mt-2 inline-flex h-11 w-full items-center justify-center rounded-lg bg-primary text-primary-foreground font-medium"
            >
              Pay online
            </a>
            <p className="text-[11px] text-muted-foreground">
              Online payment requires the restaurant&apos;s configured gateway. If unconfigured, pay at the counter —
              this page can never mark a bill paid by itself.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-bold">{state.data?.restaurantName}</h1>
            <p className="text-sm text-muted-foreground">This payment link is {state.data?.status?.toLowerCase() ?? "unavailable"}.</p>
          </>
        )}
      </div>
    </main>
  );
}

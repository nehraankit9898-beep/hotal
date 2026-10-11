"use client";

import { useMemo, useState } from "react";
import { VoiceOrder } from "@/components/public/voice-order";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Leaf, Flame, ShoppingCart, Minus, Plus, CheckCircle2, ChefHat, Utensils, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Phase 12/13 — public mobile menu (QR → browse → cart → order → track).
 * Mobile-first, anonymous browse; guest identity optional at submit.
 * The client generates the idempotency key once per cart session so a
 * network retry can never double-order (the server enforces it too).
 */

interface PublicOption {
  id: string;
  name: string;
  priceDeltaMinor: number;
}

interface PublicOptionGroup {
  id: string;
  name: string;
  required: boolean;
  minSelect: number;
  maxSelect: number;
  options: PublicOption[];
}

interface PublicItem {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  dietaryTags: string[];
  imageUrl: string | null;
  available: boolean;
  prepMinutes: number;
  optionGroups: PublicOptionGroup[];
}

interface PublicCategory {
  id: string;
  name: string;
  description: string | null;
  items: PublicItem[];
}

interface MenuResponse {
  restaurant: { id: string; name: string; city: string | null; location: string | null; currency: string };
  table: { id: string; number: string; zone: string | null } | null;
  session: { id: string; publicToken: string } | null;
  orderingEnabled: boolean;
  categories: PublicCategory[];
  // Phase 18 — display-safe AI features (optional; older deployments omit them)
  voiceEnabled?: boolean;
  sustainability?: Array<{ label: string; description: string | null; methodRef: string | null; source: string }>;
}

interface CartLine {
  key: string;
  item: PublicItem;
  quantity: number;
  selectedOptions: PublicOption[];
  notes: string;
}

const rupees = (minor: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(minor / 100);

function lineTotal(line: CartLine): number {
  const unit = line.item.priceMinor + line.selectedOptions.reduce((s, o) => s + o.priceDeltaMinor, 0);
  return unit * line.quantity;
}

export function PublicMenuClient({ code }: { code: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["public-menu", code],
    queryFn: () => api.get<MenuResponse>(`/api/public/menu/${code}`),
    retry: false,
  });

  const [cart, setCart] = useState<CartLine[]>([]);
  // Generated ONCE per page load (lazy initializer — stable across renders):
  // the diner's cart session key. A network retry re-sends the same key so the
  // server returns the same order instead of placing a duplicate.
  const [idempotencyKey] = useState<string>(() =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `k-${Date.now()}-${Math.random()}`,
  );
  const [detailItem, setDetailItem] = useState<PublicItem | null>(null);
  const [detailOptions, setDetailOptions] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [placedToken, setPlacedToken] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Medium fix (item 10): the tracking view previously lived ONLY in React
  // state — a diner refreshing the page lost their order-status screen and
  // landed back on the menu with no way back to their order. The token now
  // persists in sessionStorage (keyed by the table session, so moving tables
  // never shows someone else's order) and is restored when the session data
  // arrives (lazy read — no setState-in-effect).
  const restoredToken = useMemo(() => {
    if (typeof window === "undefined" || !data?.session) return null;
    try {
      return sessionStorage.getItem(`rl-track-${data.session.publicToken}`);
    } catch {
      return null; // storage unavailable (private mode) — no persistence
    }
  }, [data]);
  const activeToken = placedToken ?? restoredToken;

  function rememberPlacedToken(token: string) {
    setPlacedToken(token);
    if (data?.session) {
      try {
        sessionStorage.setItem(`rl-track-${data.session.publicToken}`, token);
      } catch {
        /* storage unavailable (private mode) — tracking just won't persist */
      }
    }
  }

  const cartCount = cart.reduce((s, l) => s + l.quantity, 0);
  const cartTotal = cart.reduce((s, l) => s + lineTotal(l), 0);

  function addToCart(item: PublicItem, options: PublicOption[], notes: string) {
    const key = `${item.id}:${options.map((o) => o.id).sort().join(",")}`;
    setCart((prev) => {
      const existing = prev.find((l) => l.key === key);
      if (existing) {
        return prev.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...prev, { key, item, quantity: 1, selectedOptions: options, notes }];
    });
    setDetailItem(null);
    setDetailOptions({});
  }

  // Phase 18 — add voice/text-proposed items (with explicit quantities) after
  // the mandatory on-screen confirmation. Same cart pipeline as taps.
  function addVoiceItems(lines: Array<{ menuItemId: string; quantity: number }>) {
    for (const line of lines) {
      for (const cat of data?.categories ?? []) {
        const item = cat.items.find((i) => i.id === line.menuItemId);
        if (!item) continue;
        const key = `${item.id}:`;
        setCart((prev) => {
          const existing = prev.find((l) => l.key === key);
          if (existing) {
            return prev.map((l) => (l.key === key ? { ...l, quantity: Math.min(50, l.quantity + line.quantity) } : l));
          }
          return [...prev, { key, item, quantity: line.quantity, selectedOptions: [], notes: "" }];
        });
        break;
      }
    }
  }

  async function submitOrder() {
    if (!data?.session || cart.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.post<{ created: boolean; order: { publicToken: string; orderNumber: number } }>(
        "/api/public/orders",
        {
          sessionToken: data.session.publicToken,
          idempotencyKey,
          cart: cart.map((l) => ({
            menuItemId: l.item.id,
            quantity: l.quantity,
            optionIds: l.selectedOptions.map((o) => o.id),
            notes: l.notes || undefined,
          })),
        },
      );
      rememberPlacedToken(res.order.publicToken);
      setCart([]);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not place the order. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (isLoading) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-4">
        <Skeleton className="h-24 rounded-2xl" />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertCircle className="h-12 w-12 text-muted-foreground/40" />
        <h1 className="text-lg font-semibold">Menu unavailable</h1>
        <p className="text-sm text-muted-foreground">
          {error instanceof Error ? error.message : "This QR code is no longer active. Please ask the restaurant staff."}
        </p>
      </div>
    );
  }

  if (activeToken) {
    return <OrderTracking token={activeToken} restaurant={data.restaurant.name} />;
  }

  const hasOrdering = data.orderingEnabled && data.session !== null;

  return (
    <div className="mx-auto min-h-screen max-w-md bg-background pb-28">
      {/* Restaurant header */}
      <div className="sticky top-0 z-20 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Utensils className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-bold leading-tight">{data.restaurant.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {data.table ? `Table ${data.table.number}` : "Menu"}
              {data.restaurant.city ? ` · ${data.restaurant.city}` : ""}
            </p>
          </div>
          {hasOrdering && <Badge variant="secondary">Order at table</Badge>}
        </div>
      </div>

      {/* Phase 18 — voice/text ordering (tenant-gated) */}
      {data.voiceEnabled && (
        <div className="px-4 pt-4">
          <VoiceOrder
            code={code}
            formatMoney={rupees}
            onConfirm={addVoiceItems}
          />
        </div>
      )}

      {/* Menu */}
      <div className="space-y-6 px-4 py-4">
        {data.categories.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Utensils className="h-10 w-10 text-muted-foreground/40" />
            <p className="font-medium">The menu is being set up</p>
            <p className="text-sm text-muted-foreground">Please check back soon.</p>
          </div>
        )}
        {data.categories.map((cat) => (
          <section key={cat.id}>
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted-foreground">{cat.name}</h2>
            <div className="space-y-2">
              {cat.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={!item.available}
                  onClick={() => {
                    if (item.optionGroups.length > 0) {
                      setDetailItem(item);
                      setDetailOptions({});
                    } else if (hasOrdering) {
                      addToCart(item, [], "");
                    }
                  }}
                  className={cn(
                    "w-full rounded-xl border bg-card p-3.5 text-left transition active:scale-[0.99]",
                    !item.available && "opacity-50",
                    item.optionGroups.length === 0 && !hasOrdering && "cursor-default",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="text-sm font-semibold">{item.name}</p>
                        {item.dietaryTags.includes("VEG") && <Leaf className="h-3.5 w-3.5 text-green-600" aria-label="Vegetarian" />}
                        {item.dietaryTags.includes("NON_VEG") && (
                          <span className="text-xs font-bold text-red-600" aria-label="Non-vegetarian">•NV</span>
                        )}
                        {item.dietaryTags.includes("SPICY") && <Flame className="h-3.5 w-3.5 text-orange-500" aria-label="Spicy" />}
                      </div>
                      {item.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.description}</p>}
                      <p className="mt-1 text-xs text-muted-foreground">~{item.prepMinutes} min</p>
                    </div>
                    {/* Audit fix (Phase 12): the fixture's photo URL rendered 0
                        <img> elements — the owner-uploaded photo was stored but
                        never displayed. Plain <img> (CSP img-src allows https:). */}
                    {item.imageUrl && (
                      <img
                        src={item.imageUrl}
                        alt={item.name}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="h-16 w-16 flex-none rounded-lg border object-cover"
                      />
                    )}
                    <div className="flex flex-col items-end gap-1.5">
                      <p className="text-sm font-bold tabular-nums">{rupees(item.priceMinor)}</p>
                      {!item.available ? (
                        <Badge variant="outline">Sold out</Badge>
                      ) : hasOrdering ? (
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <Plus className="h-4 w-4" />
                        </span>
                      ) : null}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* Phase 18 — self-reported sustainability badges (labelled as such) */}
      {(data.sustainability?.length ?? 0) > 0 && (
        <div className="px-4 pb-2">
          <div className="rounded-xl border bg-muted/30 p-3">
            <p className="text-xs font-medium flex items-center gap-1.5">
              <Leaf className="h-3.5 w-3.5" /> Sustainability
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {data.sustainability!.map((b, i) => (
                <Badge key={i} variant="outline" className="text-[11px]" title={b.methodRef ?? b.description ?? undefined}>
                  {b.label} · {b.source === "SELF_REPORTED" ? "self-reported" : b.source}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Item options sheet */}
      {detailItem && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/50" onClick={() => setDetailItem(null)}>
          <div
            className="mx-auto max-h-[80vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-background p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between">
              <div>
                <p className="text-base font-bold">{detailItem.name}</p>
                <p className="text-sm text-muted-foreground">{rupees(detailItem.priceMinor)}</p>
              </div>
              <Button variant="ghost" size="icon" aria-label="Close" onClick={() => setDetailItem(null)}>
                ✕
              </Button>
            </div>
            {detailItem.optionGroups.map((group) => (
              <div key={group.id} className="mb-5">
                <p className="mb-1.5 text-sm font-semibold">
                  {group.name}
                  {group.required && <span className="ml-1 text-xs text-destructive">*required</span>}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {group.maxSelect > 1 ? `choose up to ${group.maxSelect}` : "choose 1"}
                  </span>
                </p>
                <div className="space-y-1.5">
                  {group.options.map((opt) => {
                    const selected = (detailOptions[group.id] ?? []).includes(opt.id);
                    return (
                      <label
                        key={opt.id}
                        className={cn(
                          "flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2.5 text-sm",
                          selected && "border-primary bg-primary/5",
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type={group.maxSelect > 1 ? "checkbox" : "radio"}
                            className="h-4 w-4 accent-[hsl(var(--primary))]"
                            checked={selected}
                            onChange={() => {
                              setDetailOptions((prev) => {
                                const current = prev[group.id] ?? [];
                                if (group.maxSelect > 1) {
                                  const next = selected
                                    ? current.filter((id) => id !== opt.id)
                                    : [...current, opt.id].slice(0, group.maxSelect);
                                  return { ...prev, [group.id]: next };
                                }
                                return { ...prev, [group.id]: selected ? [] : [opt.id] };
                              });
                            }}
                          />
                          {opt.name}
                        </span>
                        {opt.priceDeltaMinor > 0 && <span className="text-xs text-muted-foreground">+{rupees(opt.priceDeltaMinor)}</span>}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
            <Button
              className="w-full"
              onClick={() => {
                const selected = detailItem.optionGroups.flatMap((g) =>
                  (detailOptions[g.id] ?? []).map((id) => g.options.find((o) => o.id === id)!).filter(Boolean),
                );
                const missing = detailItem.optionGroups.find(
                  (g) => g.required && (detailOptions[g.id] ?? []).length < Math.max(1, g.minSelect),
                );
                if (missing) return;
                addToCart(detailItem, selected, "");
              }}
            >
              Add to cart
            </Button>
          </div>
        </div>
      )}

      {/* Cart bar */}
      {cartCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md border-t bg-background/95 p-3 backdrop-blur">
          {submitError && <p className="mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{submitError}</p>}
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <ShoppingCart className="h-5 w-5" />
              <span className="absolute mt-6 ml-6 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {cartCount}
              </span>
            </div>
            <div className="flex-1">
              <p className="text-sm font-bold tabular-nums">{rupees(cartTotal)}</p>
              <div className="flex gap-1">
                {cart.slice(0, 3).map((l) => (
                  <span key={l.key} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                    {l.quantity}× {l.item.name}
                  </span>
                ))}
              </div>
            </div>
            <Button onClick={submitOrder} disabled={submitting || !hasOrdering}>
              {submitting ? "Placing…" : "Place order"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Order tracking (post-submit)                                        */
/* ------------------------------------------------------------------ */

interface TrackingResponse {
  order: {
    orderNumber: number;
    status: "PLACED" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";
    currency: string;
    totalMinor: number;
    placedAt: string;
    tableNumber: string | null;
    items: { name: string; quantity: number; lineTotalMinor: number; options: unknown[]; status: string }[];
  };
}

function OrderTracking({ token, restaurant }: { token: string; restaurant: string }) {
  const { data } = useQuery({
    queryKey: ["public-order", token],
    queryFn: () => api.get<TrackingResponse>(`/api/public/orders/${token}`),
    refetchInterval: (query) =>
      query.state.data?.order.status === "SERVED" || query.state.data?.order.status === "CANCELLED"
        ? false
        : 8_000,
  });

  const order = data?.order;
  const status = order?.status ?? "PLACED";

  const steps: { key: string; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: "PLACED", label: "Order placed", icon: CheckCircle2 },
    { key: "PREPARING", label: "Kitchen preparing", icon: ChefHat },
    { key: "READY", label: "Ready", icon: Utensils },
    { key: "SERVED", label: "Served", icon: CheckCircle2 },
  ];
  const stepIndex = status === "PLACED" ? 0 : status === "PREPARING" ? 1 : status === "READY" ? 2 : 3;

  return (
    <div className="mx-auto min-h-screen max-w-md bg-background p-4">
      <div className="mb-6 text-center">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">{restaurant}</p>
        <h1 className="mt-1 text-2xl font-bold">Order #{order?.orderNumber ?? "…"}</h1>
        {order?.tableNumber && <p className="text-sm text-muted-foreground">Table {order.tableNumber}</p>}
      </div>

      {status === "CANCELLED" ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-center">
          <AlertCircle className="mx-auto mb-2 h-10 w-10 text-destructive" />
          <p className="font-semibold">This order was cancelled</p>
          <p className="text-sm text-muted-foreground">Please speak to our staff if this is unexpected.</p>
        </div>
      ) : (
        <div className="mb-6 space-y-3">
          {steps.map((step, i) => {
            const done = i <= stepIndex;
            return (
              <div key={step.key} className={cn("flex items-center gap-3 rounded-xl border p-3.5", done && "border-primary/40 bg-primary/5")}>
                <step.icon className={cn("h-5 w-5", done ? "text-primary" : "text-muted-foreground/40")} />
                <p className={cn("text-sm font-medium", !done && "text-muted-foreground/60")}>{step.label}</p>
                {i === stepIndex && (
                  <span className="ml-auto flex items-center gap-1 text-xs text-primary">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" /> now
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {order && (
        <div className="rounded-2xl border p-4">
          <p className="mb-2 text-sm font-semibold">Your items</p>
          <div className="space-y-1.5">
            {order.items.map((item, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span>
                  <span className="font-semibold tabular-nums">{item.quantity}×</span> {item.name}
                </span>
                <span className="tabular-nums text-muted-foreground">{rupees(item.lineTotalMinor)}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between border-t pt-3">
            <p className="text-sm font-semibold">Total</p>
            <p className="font-bold tabular-nums">{rupees(order.totalMinor)}</p>
          </div>
        </div>
      )}

      <p className="mt-6 text-center text-xs text-muted-foreground">
        This page updates automatically. Keep it open to track your order.
      </p>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { PublicPlan, SubscriptionView, UsageSummaryRow, PaymentRow } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SectionHeading, EmptyState } from "@/components/app/shared-ui";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime, formatCurrency, formatNumber } from "@/lib/format";
import {
  CreditCard,
  IndianRupee,
  CheckCircle2,
  Loader2,
  Ticket,
  Clock,
  FileText,
  Sparkles,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";

/**
 * Billing & Plan — Phase 10 (tenant view).
 *
 * Shows the hotel's CURRENT subscription + trial state (server-verified via
 * /api/subscription), usage vs limits, the plan catalogue (always loaded from
 * /api/pricing — never hardcoded prices) and checkout with coupon support.
 * Available to any signed-in hotel user (read-only); purchase is limited to
 * owner/admin server-side.
 *
 * RECHECK FIX (C — real payment checkout): when the server checkout response
 * carries a Razorpay `checkout` payload (provider order id + publishable key
 * + minor-unit amount), the REAL Razorpay Checkout widget is opened. Its
 * browser callback is confirmed server-side (signature + authoritative
 * amount) via POST /api/billing/checkout/verify, and the invoice status is
 * polled from GET /api/billing/checkout/[paymentId] so the UI always shows
 * the honest state (PENDING / PAID / FAILED). Manual-provider invoices keep
 * the "awaiting platform confirmation" flow.
 */

/** Minimal shape of window.Razorpay from checkout.js (typed locally). */
interface RazorpayCheckoutInstance {
  open: () => void;
  on: (event: string, handler: (resp: unknown) => void) => void;
}
interface RazorpayConstructorOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  theme?: { color?: string };
  handler: (response: {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  }) => void;
  modal?: { ondismiss?: () => void };
}
interface RazorpayStatic {
  new (options: RazorpayConstructorOptions): RazorpayCheckoutInstance;
}

/** Load checkout.js once (idempotent); rejects when blocked/offline. */
let checkoutJsPromise: Promise<RazorpayStatic> | null = null;
function loadRazorpayCheckout(): Promise<RazorpayStatic> {
  if (typeof window === "undefined") return Promise.reject(new Error("Client-only"));
  const existing = (window as unknown as { Razorpay?: RazorpayStatic }).Razorpay;
  if (existing) return Promise.resolve(existing);
  if (checkoutJsPromise) return checkoutJsPromise;
  checkoutJsPromise = new Promise<RazorpayStatic>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => {
      const ctor = (window as unknown as { Razorpay?: RazorpayStatic }).Razorpay;
      if (ctor) resolve(ctor);
      else reject(new Error("Razorpay Checkout failed to initialise."));
    };
    script.onerror = () => {
      checkoutJsPromise = null;
      reject(new Error("Could not load Razorpay Checkout (network blocked?)."));
    };
    document.head.appendChild(script);
  });
  return checkoutJsPromise;
}

interface CheckoutResponse {
  invoiceNumber: string;
  amount: number;
  discount: number;
  provider: string;
  baseAmount: number;
  currency: string;
  paymentId: string;
  checkout?: {
    providerOrderId: string;
    publishableKeyId: string | null;
    amountMinor: number;
    currency: string;
    mode: "test" | "live";
  };
}

export function BillingView() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [checkout, setCheckout] = useState<{ open: boolean; plan: PublicPlan | null }>({
    open: false,
    plan: null,
  });
  const [cycle, setCycle] = useState<"MONTHLY" | "YEARLY">("MONTHLY");
  const [couponCode, setCouponCode] = useState("");
  const [paymentState, setPaymentState] = useState<{
    open: boolean;
    paymentId: string;
    invoiceNumber: string;
    amount: number;
    discount: number;
    provider: string;
    openingCheckout: boolean;
    checkoutPayload: NonNullable<CheckoutResponse["checkout"]> | null;
  } | null>(null);

  const subscriptionQuery = useQuery({
    queryKey: ["subscription", "self"],
    queryFn: () =>
      api.get<{
        subscription: SubscriptionView;
        usage: { resources: UsageSummaryRow[]; plan: { name: string } | null };
        payments: PaymentRow[];
      }>("/api/subscription"),
  });
  const pricingQuery = useQuery({
    queryKey: ["pricing", "public"],
    queryFn: () => api.get<{ plans: PublicPlan[] }>("/api/pricing"),
  });

  // Honest invoice status for the payment dialog (polled while PENDING).
  const paymentStatusQuery = useQuery({
    queryKey: ["payment-status", paymentState?.paymentId],
    queryFn: () =>
      api.get<{
        payment: {
          status: string;
          provider: string;
          failureReason: string | null;
          paidAt: string | null;
        };
      }>(`/api/billing/checkout/${paymentState?.paymentId ?? ""}`),
    enabled: Boolean(paymentState?.open && paymentState?.paymentId),
    refetchInterval: (q) => {
      const status = q.state.data?.payment.status;
      return status === "PENDING" ? 4000 : false; // poll while unpaid
    },
  });

  const createCheckout = useMutation({
    mutationFn: (plan: PublicPlan): Promise<CheckoutResponse> =>
      api.post<CheckoutResponse>("/api/billing/checkout", {
        planKey: plan.key,
        billingCycle: cycle,
        couponCode: couponCode || undefined,
      }),
    onSuccess: (res) => {
      setCheckout({ open: false, plan: null });
      setCouponCode("");
      setPaymentState({
        open: true,
        paymentId: res.paymentId,
        invoiceNumber: res.invoiceNumber,
        amount: res.amount,
        discount: res.discount,
        provider: res.provider,
        openingCheckout: Boolean(res.checkout),
        checkoutPayload: res.checkout ?? null,
      });
      void subscriptionQuery.refetch();
      void qc.invalidateQueries({ queryKey: ["payment-status"] });
    },
    onError: (err) => {
      toast({
        title: "Checkout failed",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  if (subscriptionQuery.isLoading) return <Skeleton className="h-96 w-full" />;
  const sub = subscriptionQuery.data?.subscription;
  const usage = subscriptionQuery.data?.usage;
  const payments = subscriptionQuery.data?.payments ?? [];
  const plans = pricingQuery.data?.plans ?? [];

  if (!sub) {
    return (
      <EmptyState
        icon={CreditCard}
        title="Subscription unavailable"
        description="Reload the page or contact support."
      />
    );
  }

  const isTrial = sub.state === "TRIALING";
  const isExpired = sub.state === "EXPIRED" || sub.state === "CANCELLED";

  /** RECHECK FIX (C): launch the Razorpay widget from the checkout payload. */
  async function launchRazorpay(
    checkoutPayload: NonNullable<CheckoutResponse["checkout"]>,
    paymentId: string,
  ) {
    try {
      setPaymentState((prev) => (prev ? { ...prev, openingCheckout: true } : prev));
      const Razorpay = await loadRazorpayCheckout();
      const rzp = new Razorpay({
        key: checkoutPayload.publishableKeyId ?? "",
        order_id: checkoutPayload.providerOrderId,
        amount: checkoutPayload.amountMinor,
        currency: checkoutPayload.currency,
        name: "StayLoop",
        description: `StayLoop subscription — ${checkoutPayload.mode} mode`,
        theme: { color: "#ea580c" },
        handler: (response) => {
          // Confirm server-side (signature + authoritative amount binding).
          api
            .post<{ ok: boolean }>("/api/billing/checkout/verify", {
              paymentId,
              razorpayOrderId: response.razorpay_order_id,
              razorpayPaymentId: response.razorpay_payment_id,
              razorpaySignature: response.razorpay_signature,
            })
            .then(() => {
              toast({
                title: "Payment received",
                description: "Your invoice has been marked as paid.",
              });
              setPaymentState((prev) => (prev ? { ...prev, openingCheckout: false } : prev));
              void subscriptionQuery.refetch();
              void qc.invalidateQueries({ queryKey: ["payment-status"] });
            })
            .catch((err) => {
              setPaymentState((prev) => (prev ? { ...prev, openingCheckout: false } : prev));
              toast({
                title: "Payment captured — confirmation pending",
                description:
                  err instanceof ApiError
                    ? err.message
                    : "The provider webhook will confirm this payment automatically.",
                variant: "destructive",
              });
              void qc.invalidateQueries({ queryKey: ["payment-status"] });
            });
        },
        modal: {
          ondismiss: () => {
            // Honest state: the invoice stays PENDING; nothing was charged.
            setPaymentState((prev) => (prev ? { ...prev, openingCheckout: false } : prev));
            toast({
              title: "Payment window closed",
              description: "The invoice is still pending — you can retry the payment below.",
            });
            void qc.invalidateQueries({ queryKey: ["payment-status"] });
          },
        },
      });
      rzp.on("payment.failed", () => {
        setPaymentState((prev) => (prev ? { ...prev, openingCheckout: false } : prev));
        toast({
          title: "Payment failed",
          description:
            "The provider reported a failed payment. The invoice is still pending — retry below.",
          variant: "destructive",
        });
        void qc.invalidateQueries({ queryKey: ["payment-status"] });
      });
      rzp.open();
    } catch (err) {
      setPaymentState((prev) => (prev ? { ...prev, openingCheckout: false } : prev));
      toast({
        title: "Could not open payment",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Billing & Plan"
        description="Your subscription, live usage and invoices. Plan prices come straight from the platform — never cached in the app."
      />

      {/* Trial / status banner */}
      {isTrial && (
        <Card className="border-sky-500/40 bg-sky-500/5">
          <CardContent className="flex flex-wrap items-center gap-4 py-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-sky-500/15 text-sky-600">
              <Clock className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">
                Trial active — {sub.trialDaysRemaining ?? 0}{" "}
                {sub.trialDaysRemaining === 1 ? "day" : "days"} remaining
              </p>
              <p className="text-xs text-muted-foreground">
                Started {sub.trialStartsAt ? formatDateTime(sub.trialStartsAt) : "—"} · ends{" "}
                {sub.trialEndsAt ? formatDateTime(sub.trialEndsAt) : "—"}
                {sub.graceEndsAt ? ` · grace until ${formatDateTime(sub.graceEndsAt)}` : ""}
              </p>
            </div>
            <Button
              size="sm"
              onClick={() =>
                document.getElementById("plan-catalogue")?.scrollIntoView({ behavior: "smooth" })
              }
            >
              <Sparkles className="h-4 w-4 mr-1.5" /> Upgrade now
            </Button>
          </CardContent>
        </Card>
      )}
      {isExpired && (
        <Card className="border-rose-500/40 bg-rose-500/5">
          <CardContent className="flex flex-wrap items-center gap-4 py-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-rose-500/15 text-rose-600">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">Your subscription has expired</p>
              <p className="text-xs text-muted-foreground">
                Choose a plan below to restore full access to your workspace.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      {sub.state === "GRACE" && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex flex-wrap items-center gap-4 py-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">
                Grace period — {sub.graceEndsAt ? `until ${formatDateTime(sub.graceEndsAt)}` : ""}
              </p>
              <p className="text-xs text-muted-foreground">
                Renew now to avoid losing access to campaigns and guest data.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Current plan + usage */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Current plan</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-2xl font-bold">{sub.plan?.name ?? "No plan"}</p>
            <Badge
              variant={sub.state === "ACTIVE" ? "default" : "outline"}
              className={
                sub.state === "ACTIVE"
                  ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30"
                  : ""
              }
            >
              {sub.state}
            </Badge>
            <p className="text-sm text-muted-foreground">
              {sub.state === "TRIALING"
                ? "Trial — no charge"
                : `${formatCurrency(sub.amount)} / ${sub.billingCycle?.toLowerCase() ?? "month"}`}
            </p>
            {sub.currentPeriodEnd && (
              <p className="text-xs text-muted-foreground">
                Renews {formatDateTime(sub.currentPeriodEnd)}
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Usage this month {usage?.plan ? `(${usage.plan.name})` : ""}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-3">
              {(usage?.resources ?? []).slice(0, 6).map((r) => (
                <div key={r.resource} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="capitalize">
                      {r.resource.replace(/([A-Z])/g, " $1").toLowerCase()}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {formatNumber(r.used)} / {r.limit ? formatNumber(r.limit) : "∞"}
                    </span>
                  </div>
                  <Progress value={r.percent} className="h-2" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="plans">
        <TabsList>
          <TabsTrigger value="plans">Plans</TabsTrigger>
          <TabsTrigger value="invoices">Invoices ({payments.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="plans" className="mt-6">
          <div id="plan-catalogue" className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Available plans</h3>
              <div className="flex rounded-lg bg-muted p-0.5">
                {(["MONTHLY", "YEARLY"] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCycle(c)}
                    className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-all ${cycle === c ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                  >
                    {c === "MONTHLY" ? "Monthly" : "Yearly (2 months free)"}
                  </button>
                ))}
              </div>
            </div>
            {pricingQuery.isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : plans.length === 0 ? (
              <EmptyState
                icon={IndianRupee}
                title="No plans available"
                description="The platform has not published any public plans yet."
              />
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {plans.map((plan) => {
                  const current = sub.plan?.id === plan.id;
                  const price = cycle === "YEARLY" ? plan.yearlyPrice : plan.monthlyPrice;
                  return (
                    <Card
                      key={plan.id}
                      className={plan.recommended ? "border-primary/50 shadow-md" : ""}
                    >
                      <CardHeader className="pb-3">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-base">{plan.name}</CardTitle>
                          {plan.recommended && (
                            <Badge className="bg-primary/15 text-primary border-primary/30">
                              Best value
                            </Badge>
                          )}
                          {current && <Badge variant="outline">Current</Badge>}
                        </div>
                        {plan.description && (
                          <p className="text-xs text-muted-foreground mt-1">{plan.description}</p>
                        )}
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div>
                          <p className="text-2xl font-bold">
                            {formatCurrency(price)}
                            <span className="text-xs font-normal text-muted-foreground">
                              {" "}
                              /{cycle === "YEARLY" ? "year" : "month"}
                            </span>
                          </p>
                          {cycle === "YEARLY" && plan.monthlyPrice > 0 && (
                            <p className="text-[11px] text-muted-foreground">
                              ≈ {formatCurrency(Math.round(plan.yearlyPrice / 12))}/month
                            </p>
                          )}
                        </div>
                        <ul className="space-y-1.5 text-xs">
                          <li className="flex items-center gap-1.5">
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />{" "}
                            {plan.limits.customers
                              ? `${formatNumber(plan.limits.customers)} customers`
                              : "Unlimited customers"}
                          </li>
                          <li className="flex items-center gap-1.5">
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />{" "}
                            {plan.limits.messages
                              ? `${formatNumber(plan.limits.messages)} messages/mo`
                              : "Unlimited messages"}
                          </li>
                          <li className="flex items-center gap-1.5">
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />{" "}
                            {plan.limits.staff ? `${plan.limits.staff} staff` : "Unlimited staff"}
                          </li>
                          {plan.features.slice(0, 3).map((f) => (
                            <li key={f} className="flex items-center gap-1.5">
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />{" "}
                              {f.replace(/_/g, " ").toLowerCase()}
                            </li>
                          ))}
                        </ul>
                        <Button
                          className="w-full"
                          variant={plan.recommended ? "default" : "outline"}
                          disabled={current}
                          onClick={() => {
                            setCheckout({ open: true, plan });
                            setPaymentState(null);
                          }}
                        >
                          {current
                            ? "Current plan"
                            : plan.monthlyPrice === 0 && isTrial
                              ? "Keep on free"
                              : isTrial
                                ? "Upgrade now"
                                : "Switch plan"}
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="invoices" className="mt-6">
          {payments.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No invoices yet"
              description="Invoices appear here after your first checkout."
            />
          ) : (
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left p-3 text-xs font-semibold">Invoice</th>
                      <th className="text-left p-3 text-xs font-semibold">Description</th>
                      <th className="text-left p-3 text-xs font-semibold">Amount</th>
                      <th className="text-left p-3 text-xs font-semibold">Status</th>
                      <th className="text-left p-3 text-xs font-semibold">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.id} className="border-b last:border-0">
                        <td className="p-3 font-mono text-xs">{p.invoiceNumber}</td>
                        <td className="p-3 text-xs">{p.description ?? `${p.billingCycle} plan`}</td>
                        <td className="p-3 text-sm">
                          {formatCurrency(p.amount)}
                          {p.discountAmount > 0 && (
                            <p className="text-[10px] text-muted-foreground">
                              -{formatCurrency(p.discountAmount)}{" "}
                              {p.couponCode ? `(${p.couponCode})` : ""}
                            </p>
                          )}
                        </td>
                        <td className="p-3">
                          <Badge
                            variant="outline"
                            className={
                              p.status === "PAID"
                                ? "bg-emerald-500/10 text-emerald-600"
                                : p.status === "PENDING"
                                  ? "bg-amber-500/10 text-amber-600"
                                  : p.status === "FAILED"
                                    ? "bg-rose-500/10 text-rose-600"
                                    : ""
                            }
                          >
                            {p.status}
                          </Badge>
                        </td>
                        <td className="p-3 text-xs">{formatDateTime(p.paidAt ?? p.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* Checkout dialog */}
      <Dialog
        open={checkout.open}
        onOpenChange={(o) => !o && setCheckout({ open: false, plan: null })}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Checkout — {checkout.plan?.name}</DialogTitle>
            <DialogDescription>
              {cycle === "MONTHLY" ? "Monthly" : "Yearly"} billing · Razorpay (cards, UPI,
              netbanking) when configured, otherwise a platform-confirmed invoice.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <span className="text-sm">Plan total ({cycle.toLowerCase()})</span>
              <span className="text-lg font-bold">
                {formatCurrency(
                  cycle === "YEARLY"
                    ? (checkout.plan?.yearlyPrice ?? 0)
                    : (checkout.plan?.monthlyPrice ?? 0),
                )}
              </span>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs flex items-center gap-1">
                <Ticket className="h-3.5 w-3.5" /> Coupon code (optional)
              </Label>
              <Input
                value={couponCode}
                onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                placeholder="EARLY20"
                className="h-9 font-mono"
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              With Razorpay configured you&apos;ll pay through the secure Razorpay window and the
              invoice updates automatically. Without it, an invoice is created and the platform
              confirms your bank/UPI transfer manually.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCheckout({ open: false, plan: null })}>
              Cancel
            </Button>
            <Button
              onClick={() => checkout.plan && createCheckout.mutate(checkout.plan)}
              disabled={createCheckout.isPending}
            >
              {createCheckout.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <CreditCard className="h-4 w-4 mr-1.5" />
              )}
              Confirm checkout
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Payment status dialog (RECHECK FIX C) */}
      <Dialog open={paymentState?.open === true} onOpenChange={(o) => !o && setPaymentState(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {paymentStatusQuery.data?.payment.status === "PAID" ? (
                <>
                  <CheckCircle2 className="h-5 w-5 text-emerald-600" /> Payment complete
                </>
              ) : (
                <>
                  <Clock className="h-5 w-5 text-amber-600" /> Invoice created
                </>
              )}
            </DialogTitle>
            <DialogDescription>
              Invoice <span className="font-mono">{paymentState?.invoiceNumber}</span> for{" "}
              <b>{formatCurrency(paymentState?.amount ?? 0)}</b>
              {paymentState && paymentState.discount > 0 && (
                <> (discount {formatCurrency(paymentState.discount)} applied)</>
              )}
              .
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <span className="text-sm">Status</span>
              <Badge
                variant="outline"
                className={
                  paymentStatusQuery.data?.payment.status === "PAID"
                    ? "bg-emerald-500/10 text-emerald-600"
                    : paymentStatusQuery.data?.payment.status === "FAILED"
                      ? "bg-rose-500/10 text-rose-600"
                      : "bg-amber-500/10 text-amber-600"
                }
              >
                {paymentStatusQuery.isFetching
                  ? "checking…"
                  : (paymentStatusQuery.data?.payment.status ?? "PENDING")}
              </Badge>
            </div>
            {paymentStatusQuery.data?.payment.status === "PAID" ? (
              <p className="text-xs text-emerald-600">
                Payment received — your subscription is active. Thank you!
              </p>
            ) : paymentState?.provider === "razorpay" ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Awaiting payment capture. If the payment window closed or the bank is still
                  processing, you can retry — the invoice updates automatically once Razorpay
                  confirms.
                </p>
                {paymentState.checkoutPayload ? (
                  <Button
                    className="w-full"
                    disabled={paymentState.openingCheckout}
                    onClick={() =>
                      launchRazorpay(paymentState.checkoutPayload!, paymentState.paymentId)
                    }
                  >
                    {paymentState.openingCheckout ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                    ) : (
                      <ExternalLink className="h-4 w-4 mr-1.5" />
                    )}
                    Pay now with Razorpay
                  </Button>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    Retry the payment from the plan card (Switch plan → Confirm checkout) — the
                    pending invoice is reused automatically.
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                This invoice awaits manual confirmation — the platform verifies your bank/UPI
                transfer against it. Online card/UPI checkout is available once Razorpay is
                configured on the platform.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentState(null)}>
              Close
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                void subscriptionQuery.refetch();
                void qc.invalidateQueries({ queryKey: ["payment-status"] });
              }}
            >
              Refresh status
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

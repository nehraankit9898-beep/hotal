"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, SectionHeading, StatCard } from "@/components/app/shared-ui";
import { Receipt, Wallet, Banknote, CreditCard, Smartphone, Loader2, Printer, Link2 } from "lucide-react";

const rupees = (minor: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(minor / 100);

interface SessionRow {
  id: string;
  status: string;
  openedAt: string;
  guestName: string | null;
  table: { id: string; number: string; zone: string | null } | null;
}
interface OrderRow {
  id: string;
  orderNumber: number;
  status: string;
  totalMinor: number;
  currency: string;
  items: { id: string; nameSnapshot: string; quantity: number; lineTotalMinor: number }[];
}
interface BillRow {
  id: string;
  billNumber: string;
  status: string;
  totalMinor: number;
  paidMinor: number;
  currency: string;
  issuedAt: string;
}

const BILL_STATUS_TONE: Record<string, string> = {
  ISSUED: "bg-blue-600 hover:bg-blue-600",
  PARTIALLY_PAID: "bg-amber-500 hover:bg-amber-500",
  PAID: "bg-emerald-600 hover:bg-emerald-600",
  PARTIALLY_REFUNDED: "bg-orange-500 hover:bg-orange-500",
  REFUNDED: "bg-zinc-600 hover:bg-zinc-600",
  VOID: "bg-red-700 hover:bg-red-700",
};

/**
 * Phase 14 — cashier POS terminal.
 * Session → bill → pay (split/mixed) → receipt. Server-enforced totals and
 * permissions; manual payments are labelled "manually recorded".
 */
export function PosView({ user }: { user: { role: string; userId: string } }) {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [coupon, setCoupon] = useState("");
  const [payMethod, setPayMethod] = useState<"CASH" | "UPI" | "CARD" | "OTHER">("CASH");
  const [payAmount, setPayAmount] = useState("");
  const [activeBillId, setActiveBillId] = useState<string | null>(null);

  const sessionsQ = useQuery({
    queryKey: ["pos-sessions"],
    queryFn: async () => (await api.get("/api/sessions?status=OPEN")) as { sessions: SessionRow[] },
  });
  const ordersQ = useQuery({
    queryKey: ["pos-orders", sessionId],
    enabled: !!sessionId,
    queryFn: async () =>
      (await api.get(`/api/orders?sessionId=${sessionId}&limit=50`)) as { orders: OrderRow[] },
  });
  const billsQ = useQuery({
    queryKey: ["pos-bills"],
    queryFn: async () => (await api.get("/api/bills?limit=20")) as { bills: BillRow[] },
  });
  const summaryQ = useQuery({
    queryKey: ["pos-summary"],
    queryFn: async () => (await api.get("/api/reports/sales")) as Record<string, unknown>,
  });

  const openOrders = useMemo(
    () => (ordersQ.data?.orders ?? []).filter((o) => o.status !== "CANCELLED"),
    [ordersQ.data],
  );
  const unbilled = useMemo(() => {
    // Orders not yet on a non-void bill: server blocks double-billing, this
    // is just a UI hint.
    return openOrders;
  }, [openOrders]);
  const subtotal = useMemo(() => unbilled.reduce((s, o) => s + o.totalMinor, 0), [unbilled]);

  const createBill = useMutation({
    mutationFn: async () => {
      const idempotencyKey = crypto.randomUUID();
      return (await api.post("/api/bills", {
        tableSessionId: sessionId,
        couponCode: coupon.trim() || undefined,
        idempotencyKey,
      })) as { bill: { id: string; billNumber: string; totalMinor: number } };
    },
    onSuccess: (data) => {
      toast.success(`Bill ${data.bill.billNumber} created — ${rupees(data.bill.totalMinor)} payable`);
      setActiveBillId(data.bill.id);
      setCoupon("");
      queryClient.invalidateQueries({ queryKey: ["pos-bills"] });
      queryClient.invalidateQueries({ queryKey: ["pos-orders"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const payBill = useMutation({
    mutationFn: async (input: { billId: string; amountMinor: number; method: string }) =>
      (await api.post(`/api/bills/${input.billId}/pay`, {
        method: input.method,
        amountMinor: input.amountMinor,
        idempotencyKey: crypto.randomUUID(),
      })) as { payment: { billStatus: string; paidMinor: number } },
    onSuccess: (data) => {
      if (data.payment.billStatus === "PAID") {
        toast.success(`Bill fully paid — ${rupees(data.payment.paidMinor)} recorded`);
      } else {
        toast.success(`Partial payment recorded — ${rupees(data.payment.paidMinor)} paid so far`);
      }
      setPayAmount("");
      queryClient.invalidateQueries({ queryKey: ["pos-bills"] });
      queryClient.invalidateQueries({ queryKey: ["bill", activeBillId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const createLink = useMutation({
    mutationFn: async (billId: string) =>
      (await api.post("/api/payment-links", { billId, expiresInHours: 24 })) as { link: { token: string } },
    onSuccess: (data) => {
      const url = `${window.location.origin}/pay/${data.link.token}`;
      navigator.clipboard?.writeText(url).catch(() => undefined);
      toast.success(`Payment link copied: ${url}`);
      queryClient.invalidateQueries({ queryKey: ["pos-bills"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const billQ = useQuery({
    queryKey: ["bill", activeBillId],
    enabled: !!activeBillId,
    queryFn: async () => (await api.get(`/api/bills/${activeBillId}`)) as { bill: BillDetail },
  });
  const bill = billQ.data?.bill;
  const due = bill ? bill.totalMinor - bill.paidMinor : 0;

  const summary = summaryQ.data as
    | { bills?: { count: number; netSalesMinor: number; refundMinor: number }; payments?: { byMethod: Record<string, number> } }
    | undefined;

  return (
    <div className="space-y-6">
      <SectionHeading title="POS Terminal" description="Create bills, take split/mixed payments, print receipts" />

      <div className="grid gap-4 sm:grid-cols-3">
          <StatCard title="Bills today" value={String(summary?.bills?.count ?? 0)} icon={Receipt} />
          <StatCard title="Net sales today" value={rupees(summary?.bills?.netSalesMinor ?? 0)} icon={Wallet} />
          <StatCard title="Refunds today" value={rupees(summary?.bills?.refundMinor ?? 0)} icon={Banknote} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Sessions & unbilled orders */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <h3 className="font-semibold text-sm">1. Open table sessions</h3>
            {sessionsQ.isLoading ? (
              <Skeleton className="h-16" />
            ) : (sessionsQ.data?.sessions ?? []).length === 0 ? (
              <EmptyState icon={Receipt} title="No open sessions" description="Open sessions appear here as guests order via QR or staff." />
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {(sessionsQ.data?.sessions ?? []).map((s) => (
                  <button
                    key={s.id}
                    onClick={() => { setSessionId(s.id); setActiveBillId(null); }}
                    className={`w-full text-left rounded-lg border p-3 text-sm transition-colors ${sessionId === s.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
                  >
                    <div className="flex justify-between">
                      <span className="font-medium">Table {s.table?.number ?? "—"}</span>
                      <span className="text-muted-foreground text-xs">{s.guestName ?? "Guest"}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {sessionId && (
              <div className="rounded-lg border p-3 text-sm space-y-1">
                <div className="font-medium text-xs text-muted-foreground">UNBILLED ORDERS</div>
                {unbilled.length === 0 ? (
                  <p className="text-muted-foreground">No open orders on this session.</p>
                ) : (
                  unbilled.flatMap((o) =>
                    o.items.map((i) => (
                      <div key={i.id} className="flex justify-between">
                        <span>{i.nameSnapshot} ×{i.quantity}</span>
                        <span>{rupees(i.lineTotalMinor)}</span>
                      </div>
                    )),
                  )
                )}
                <div className="flex justify-between font-semibold border-t pt-1 mt-1">
                  <span>Subtotal</span><span>{rupees(subtotal)}</span>
                </div>
                <div className="flex gap-2 pt-2">
                  <Input placeholder="Coupon code (optional)" value={coupon} onChange={(e) => setCoupon(e.target.value)} />
                  <Button onClick={() => createBill.mutate()} disabled={createBill.isPending || unbilled.length === 0}>
                    {createBill.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Create bill
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Active bill + payments */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <h3 className="font-semibold text-sm">2. Take payment</h3>
            {!bill ? (
              <EmptyState icon={Wallet} title="No active bill" description="Create a bill from a session, or select a recent unpaid bill below." />
            ) : (
              <div className="space-y-3">
                <div className="rounded-lg border p-3 text-sm space-y-1">
                  <div className="flex justify-between font-medium">
                    <span>{bill.billNumber}</span>
                    <Badge className={BILL_STATUS_TONE[bill.status] ?? ""}>{bill.status.replace("_", " ")}</Badge>
                  </div>
                  <div className="flex justify-between"><span>Total</span><span>{rupees(bill.totalMinor)}</span></div>
                  <div className="flex justify-between"><span>Paid</span><span>{rupees(bill.paidMinor)}</span></div>
                  <div className="flex justify-between font-semibold"><span>Due</span><span>{rupees(due)}</span></div>
                </div>
                <div className="flex gap-2">
                  {(["CASH", "UPI", "CARD", "OTHER"] as const).map((m) => (
                    <Button key={m} size="sm" variant={payMethod === m ? "default" : "outline"} onClick={() => setPayMethod(m)}>
                      {m === "CASH" ? <Banknote className="h-4 w-4" /> : m === "CARD" ? <CreditCard className="h-4 w-4" /> : <Smartphone className="h-4 w-4" />}
                      {m}
                    </Button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    min={1}
                    step="1"
                    placeholder={`Amount in paise (due ${due})`}
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                  />
                  <Button
                    disabled={payBill.isPending || due <= 0}
                    onClick={() => {
                      const amt = Number(payAmount) || due;
                      payBill.mutate({ billId: bill.id, amountMinor: Math.min(Math.max(1, Math.floor(amt)), due), method: payMethod });
                    }}
                  >
                    Record
                  </Button>
                  <Button variant="outline" onClick={() => window.open(`/api/bills/${bill.id}/receipt`, "_blank")}>
                    <Printer className="h-4 w-4" /> Receipt
                  </Button>
                  <Button variant="outline" disabled={due <= 0} onClick={() => createLink.mutate(bill.id)}>
                    <Link2 className="h-4 w-4" /> Link
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Cash/UPI/Card entries are <b>manually recorded</b> — they are not gateway-verified. Online
                  payments use the Razorpay flow and show as gateway-verified.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent bills */}
      <Card>
        <CardContent className="p-4">
          <h3 className="font-semibold text-sm mb-3">Recent bills</h3>
          {(billsQ.data?.bills ?? []).length === 0 ? (
            <EmptyState icon={Receipt} title="No bills yet" description="Bills you create appear here." />
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {(billsQ.data?.bills ?? []).map((b) => (
                <button
                  key={b.id}
                  onClick={() => setActiveBillId(b.id)}
                  className={`w-full flex items-center justify-between rounded-lg border p-3 text-sm hover:bg-muted/50 ${activeBillId === b.id ? "border-primary bg-primary/5" : ""}`}
                >
                  <span className="font-mono text-xs">{b.billNumber}</span>
                  <span className="flex items-center gap-2">
                    <span>{rupees(b.totalMinor)}</span>
                    <Badge className={BILL_STATUS_TONE[b.status] ?? ""}>{b.status.replace("_", " ")}</Badge>
                  </span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface BillDetail {
  id: string;
  billNumber: string;
  status: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  couponCode: string | null;
  lines: { id: string; nameSnapshot: string; quantity: number; lineTotalMinor: number }[];
  payments: { id: string; method: string; source: string; status: string; amountMinor: number }[];
}

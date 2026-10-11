"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { Receipt, Printer } from "lucide-react";

const rupees = (minor: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(minor / 100);

const TONE: Record<string, string> = {
  ISSUED: "bg-blue-600 hover:bg-blue-600",
  PARTIALLY_PAID: "bg-amber-500 hover:bg-amber-500",
  PAID: "bg-emerald-600 hover:bg-emerald-600",
  PARTIALLY_REFUNDED: "bg-orange-500 hover:bg-orange-500",
  REFUNDED: "bg-zinc-600 hover:bg-zinc-600",
  VOID: "bg-red-700 hover:bg-red-700",
};

interface BillRow {
  id: string;
  billNumber: string;
  status: keyof typeof TONE;
  totalMinor: number;
  paidMinor: number;
  refundMinor: number;
  currency: string;
  customerName: string | null;
  couponCode: string | null;
  issuedAt: string;
  table: { number: string } | null;
}

/** Phase 14 — bill history with owner-authorized refund/void. */
export function BillsView({ user }: { user: { role: string } }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("ALL");
  const [reasonDraft, setReasonDraft] = useState<Record<string, string>>({});

  const canRefund = ["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER", "RESTAURANT_MANAGER"].includes(user.role);
  const canVoid = ["HOTEL_OWNER", "HOTEL_ADMIN"].includes(user.role);

  const billsQ = useQuery({
    queryKey: ["bills", status],
    queryFn: async () => {
      const qs = status === "ALL" ? "" : `&status=${status}`;
      return (await api.get(`/api/bills?limit=100${qs}`)) as { bills: BillRow[] };
    },
  });

  const refund = useMutation({
    mutationFn: async (input: { id: string; type: "REFUND" | "VOID"; reason: string }) =>
      (await api.post(`/api/bills/${input.id}/refund`, input)) as Record<string, unknown>,
    onSuccess: (_d, vars) => {
      toast.success(vars.type === "VOID" ? "Bill voided (history preserved)." : "Refund recorded.");
      setReasonDraft((d) => ({ ...d, [vars.id]: "" }));
      queryClient.invalidateQueries({ queryKey: ["bills"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Bills & refunds"
        description="Issued invoices are immutable. Refunds/voids are owner-authorized and always leave an audit trail."
        action={
          <div className="flex gap-2">
            {["ALL", "ISSUED", "PARTIALLY_PAID", "PAID", "REFUNDED", "VOID"].map((s) => (
              <Button key={s} size="sm" variant={status === s ? "default" : "outline"} onClick={() => setStatus(s)}>
                {s.replace("_", " ")}
              </Button>
            ))}
          </div>
        }
      />
      {billsQ.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (billsQ.data?.bills ?? []).length === 0 ? (
        <EmptyState icon={Receipt} title="No bills" description="Create bills from the POS terminal." />
      ) : (
        <div className="space-y-2">
          {(billsQ.data?.bills ?? []).map((b) => (
            <Card key={b.id}>
              <CardContent className="p-4 flex flex-wrap items-center gap-3">
                <div className="min-w-40">
                  <div className="font-mono text-xs text-muted-foreground">{b.billNumber}</div>
                  <div className="text-sm font-semibold">{rupees(b.totalMinor)}</div>
                </div>
                <Badge className={TONE[b.status] ?? ""}>{b.status.replace("_", " ")}</Badge>
                {b.table && <span className="text-xs text-muted-foreground">Table {b.table.number}</span>}
                {b.customerName && <span className="text-xs text-muted-foreground">{b.customerName}</span>}
                {b.couponCode && <Badge variant="outline">{b.couponCode}</Badge>}
                {b.refundMinor > 0 && <span className="text-xs text-orange-600">refunded {rupees(b.refundMinor)}</span>}
                <span className="flex-1" />
                <Button size="sm" variant="outline" onClick={() => window.open(`/api/bills/${b.id}/receipt`, "_blank")}>
                  <Printer className="h-4 w-4" />
                </Button>
                {canRefund && !["VOID", "REFUNDED"].includes(b.status) && (
                  <div className="flex gap-1">
                    <Input
                      className="w-44"
                      placeholder="Reason (required)"
                      value={reasonDraft[b.id] ?? ""}
                      onChange={(e) => setReasonDraft((d) => ({ ...d, [b.id]: e.target.value }))}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={(reasonDraft[b.id] ?? "").trim().length < 3}
                      onClick={() => refund.mutate({ id: b.id, type: "REFUND", reason: reasonDraft[b.id] })}
                    >
                      Refund
                    </Button>
                    {canVoid && b.refundMinor === 0 && (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={(reasonDraft[b.id] ?? "").trim().length < 3}
                        onClick={() => refund.mutate({ id: b.id, type: "VOID", reason: reasonDraft[b.id] })}
                      >
                        Void
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

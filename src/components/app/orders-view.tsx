"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { ClipboardList, CheckCheck } from "lucide-react";

interface OrderRow {
  id: string;
  orderNumber: number;
  status: "PLACED" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";
  source: "QR_CUSTOMER" | "STAFF";
  subtotalMinor: number;
  totalMinor: number;
  currency: string;
  notes: string | null;
  customerName: string | null;
  placedAt: string;
  servedAt: string | null;
  updatedAt: string;
  table: { id: string; number: string; zone: string | null } | null;
  tableSessionId: string | null;
  items: {
    id: string;
    nameSnapshot: string;
    quantity: number;
    lineTotalMinor: number;
    status: string;
    notes: string | null;
  }[];
}

const STATUS_TONE: Record<string, string> = {
  PLACED: "bg-blue-600 hover:bg-blue-600",
  PREPARING: "bg-amber-500 hover:bg-amber-500",
  READY: "bg-emerald-600 hover:bg-emerald-600",
  SERVED: "bg-zinc-600 hover:bg-zinc-600",
  CANCELLED: "bg-red-700 hover:bg-red-700",
};

const rupees = (minor: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(minor / 100);

/**
 * Phase 13 — floor / orders view (waiter + manager).
 * Shows the order stream with serve actions. Waiters see ORDER_READ/UPDATE;
 * the same engine the QR flow uses does the pricing and state machine.
 */
export function OrdersView({ user }: { user: { role: string; userId: string } }) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("ACTIVE");

  const { data, isLoading } = useQuery({
    queryKey: ["orders", statusFilter],
    queryFn: () =>
      api.get<{ orders: OrderRow[] }>(
        `/api/orders?${statusFilter === "ACTIVE" ? "status=PLACED&status=PREPARING&status=READY" : `limit=100`}`,
      ),
    refetchInterval: 10_000,
  });

  const transition = useMutation({
    mutationFn: ({ id, to, reason }: { id: string; to: string; reason?: string }) =>
      api.patch(`/api/orders/${id}`, { to, reason, expectedUpdatedAt: undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      toast.success("Order updated");
    },
    onError: (e) => {
      toast.error(e.message);
      queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
  });

  const orders = data?.orders ?? [];

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Orders"
        description="The live order stream from QR diners and staff. Serve when the kitchen marks orders ready."
      />

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {orders.length} order{orders.length === 1 ? "" : "s"}
        </p>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ACTIVE">Active (kitchen flow)</SelectItem>
            <SelectItem value="ALL">All recent</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No orders yet"
          description="When a diner scans a table QR and orders, it appears here instantly."
        />
      ) : (
        <div className="space-y-3">
          {orders.map((order) => (
            <Card key={order.id}>
              <CardContent className="flex flex-wrap items-start gap-4 p-5">
                <div className="min-w-40 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-base font-bold">#{order.orderNumber}</p>
                    <Badge className={STATUS_TONE[order.status] ?? ""}>{order.status}</Badge>
                    <Badge variant="outline">{order.source === "QR_CUSTOMER" ? "QR" : "Staff"}</Badge>
                    {order.table && <Badge variant="secondary">Table {order.table.number}</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(order.placedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                    {order.customerName ? ` · ${order.customerName}` : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {order.items.map((item) => (
                      <span key={item.id} className="text-sm">
                        <span className="font-semibold tabular-nums">{item.quantity}×</span> {item.nameSnapshot}
                        {item.status === "CANCELLED" && <span className="ml-1 text-xs text-destructive">(cancelled)</span>}
                      </span>
                    ))}
                  </div>
                  {order.notes && <p className="mt-1.5 text-xs text-amber-700">Note: {order.notes}</p>}
                </div>

                <div className="flex flex-col items-end gap-2">
                  <p className="text-base font-bold tabular-nums">{rupees(order.totalMinor)}</p>
                  <div className="flex gap-2">
                    {order.status === "READY" && (
                      <Button
                        size="sm"
                        className="bg-emerald-600 hover:bg-emerald-700"
                        disabled={transition.isPending}
                        onClick={() => transition.mutate({ id: order.id, to: "SERVED" })}
                      >
                        <CheckCheck className="mr-1 h-4 w-4" /> Mark served
                      </Button>
                    )}
                    {(order.status === "PLACED" || order.status === "PREPARING" || order.status === "READY") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={transition.isPending}
                        onClick={() => {
                          const reason = prompt("Cancellation reason (recorded in the audit trail):");
                          if (reason && reason.trim().length >= 3) {
                            transition.mutate({ id: order.id, to: "CANCELLED", reason: reason.trim() });
                          } else if (reason !== null) {
                            toast.error("A reason of at least 3 characters is required.");
                          }
                        }}
                      >
                        Cancel
                      </Button>
                    )}
                    {order.status === "SERVED" && (
                      <span className="text-xs text-muted-foreground">
                        Served {order.servedAt ? new Date(order.servedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : ""}
                      </span>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

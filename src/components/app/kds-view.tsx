"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ChefHat, Clock, Flame, CheckCircle2, XCircle } from "lucide-react";

interface KdsItem {
  id: string;
  nameSnapshot: string;
  quantity: number;
  optionsSnapshot: string | null;
  notes: string | null;
  status: "PENDING" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";
}

interface KdsOrder {
  id: string;
  orderNumber: number;
  status: "PLACED" | "PREPARING" | "READY";
  source: "QR_CUSTOMER" | "STAFF";
  tableNumber: string | null;
  zone: string | null;
  minutesSincePlaced: number;
  notes: string | null;
  items: (KdsItem & { options: unknown[] })[];
}

/**
 * Phase 13 — Kitchen Display System.
 *
 * Live via 10-second polling (documented choice: the standalone Next server
 * has no WebSocket layer; polling reconnects trivially and every poll is a
 * full catch-up — no missed events). Buttons advance item statuses; the
 * whole-order status is derived server-side (all items ready → order READY).
 */
export function KdsView() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["kds"],
    queryFn: () => api.get<{ queue: KdsOrder[] }>("/api/kds"),
    refetchInterval: 10_000,
  });

  const itemTransition = useMutation({
    mutationFn: ({ orderId, itemId, to }: { orderId: string; itemId: string; to: string }) =>
      api.patch(`/api/orders/${orderId}/items/${itemId}`, { to }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["kds"] }),
    onError: (e) => toast.error(e.message),
  });

  const orderTransition = useMutation({
    mutationFn: ({ orderId, to, reason }: { orderId: string; to: string; reason?: string }) =>
      api.patch(`/api/orders/${orderId}`, { to, reason }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["kds"] }),
    onError: (e) => toast.error(e.message),
  });

  const queue = data?.queue ?? [];
  const placed = queue.filter((o) => o.status === "PLACED");
  const preparing = queue.filter((o) => o.status === "PREPARING");
  const ready = queue.filter((o) => o.status === "READY");

  const columns: { key: string; title: string; icon: React.ComponentType<{ className?: string }>; orders: KdsOrder[]; tone: string }[] = [
    { key: "placed", title: "New", icon: Clock, orders: placed, tone: "bg-blue-500" },
    { key: "preparing", title: "Preparing", icon: Flame, orders: preparing, tone: "bg-amber-500" },
    { key: "ready", title: "Ready to serve", icon: CheckCircle2, orders: ready, tone: "bg-emerald-600" },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <ChefHat className="h-6 w-6" /> Kitchen Display
          </h1>
          <p className="text-sm text-muted-foreground">
            Live queue · auto-refreshes every 10 s · {queue.length} active order{queue.length === 1 ? "" : "s"}
          </p>
        </div>
        <Badge variant="outline" className="gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-600" />
          </span>
          Live
        </Badge>
      </div>

      {isLoading ? (
        <div className="grid gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-72 rounded-xl" />
          ))}
        </div>
      ) : queue.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <ChefHat className="h-10 w-10 text-muted-foreground/40" />
            <p className="font-medium">All caught up</p>
            <p className="text-sm text-muted-foreground">New orders appear here the moment diners place them.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {columns.map((col) => (
            <div key={col.key} className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <span className={cn("flex h-6 w-6 items-center justify-center rounded-md text-white", col.tone)}>
                  <col.icon className="h-3.5 w-3.5" />
                </span>
                <p className="text-sm font-semibold">
                  {col.title} ({col.orders.length})
                </p>
              </div>
              {col.orders.length === 0 && (
                <p className="rounded-xl border border-dashed px-3 py-8 text-center text-xs text-muted-foreground">
                  Nothing here
                </p>
              )}
              {col.orders.map((order) => (
                <Card key={order.id} className="border-l-4" style={{ borderLeftColor: order.minutesSincePlaced > 20 ? "rgb(220 38 38)" : order.minutesSincePlaced > 10 ? "rgb(245 158 11)" : undefined }}>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-bold">#{order.orderNumber}</p>
                        <p className="text-xs text-muted-foreground">
                          {order.tableNumber ? `Table ${order.tableNumber}` : "No table"}
                          {order.zone ? ` · ${order.zone}` : ""} · {order.source === "QR_CUSTOMER" ? "QR order" : "Staff"}
                        </p>
                      </div>
                      <Badge
                        variant={order.minutesSincePlaced > 20 ? "destructive" : order.minutesSincePlaced > 10 ? "default" : "secondary"}
                        className="tabular-nums"
                      >
                        {order.minutesSincePlaced} min
                      </Badge>
                    </div>

                    <div className="space-y-1.5">
                      {order.items
                        .filter((i) => i.status !== "CANCELLED" && i.status !== "SERVED")
                        .map((item) => (
                          <div
                            key={item.id}
                            className={cn(
                              "rounded-lg border px-3 py-2",
                              item.status === "READY" && "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30",
                              item.status === "PREPARING" && "border-amber-300 bg-amber-50 dark:bg-amber-950/30",
                            )}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-medium">
                                <span className="tabular-nums font-bold">{item.quantity}×</span> {item.nameSnapshot}
                              </p>
                              <div className="flex gap-1">
                                {item.status === "PENDING" && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 px-2 text-xs"
                                    disabled={itemTransition.isPending}
                                    onClick={() =>
                                      itemTransition.mutate({ orderId: order.id, itemId: item.id, to: "PREPARING" })
                                    }
                                  >
                                    Start
                                  </Button>
                                )}
                                {item.status !== "READY" && (
                                  <Button
                                    size="sm"
                                    className="h-7 bg-emerald-600 px-2 text-xs hover:bg-emerald-700"
                                    disabled={itemTransition.isPending}
                                    onClick={() =>
                                      itemTransition.mutate({ orderId: order.id, itemId: item.id, to: "READY" })
                                    }
                                  >
                                    Ready
                                  </Button>
                                )}
                              </div>
                            </div>
                            {Array.isArray(item.options) && item.options.length > 0 && (
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {(item.options as { optionName: string }[]).map((o) => o.optionName).join(", ")}
                              </p>
                            )}
                            {item.notes && <p className="mt-0.5 text-xs font-medium text-amber-700">“{item.notes}”</p>}
                          </div>
                        ))}
                    </div>

                    {order.notes && (
                      <p className="rounded-md bg-muted px-2 py-1.5 text-xs">Order note: {order.notes}</p>
                    )}

                    <div className="flex gap-2 pt-1">
                      {order.status !== "READY" && (
                        <Button
                          size="sm"
                          className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                          disabled={orderTransition.isPending}
                          onClick={() => orderTransition.mutate({ orderId: order.id, to: "READY" })}
                        >
                          All ready
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={orderTransition.isPending}
                        onClick={() => {
                          const reason = prompt("Cancellation reason (recorded in the audit trail):");
                          if (reason && reason.trim().length >= 3) {
                            orderTransition.mutate({ orderId: order.id, to: "CANCELLED", reason: reason.trim() });
                          } else if (reason !== null) {
                            toast.error("A reason of at least 3 characters is required.");
                          }
                        }}
                      >
                        <XCircle className="mr-1 h-3.5 w-3.5" /> Cancel
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

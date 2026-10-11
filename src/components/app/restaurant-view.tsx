"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { RestaurantVisitsResponse, RestaurantVisitRow, CustomersResponse } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime, formatCurrency, formatNumber, maskPhoneDisplay } from "@/lib/format";
import { Utensils, Plus, Loader2, Users, IndianRupee, Pencil, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const SOURCE_LABELS: Record<string, string> = {
  WALK_IN: "Walk-in",
  RESERVATION: "Reservation",
  ROOM_GUEST: "In-house guest",
  EVENT: "Event attendee",
  ONLINE_ORDER: "Online order",
  QR_MENU: "QR Menu",
  WIFI_LOGIN: "Wi-Fi login",
  FEEDBACK: "Feedback form",
  LOYALTY: "Loyalty program",
};

export function RestaurantView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [page, setPage] = useState(1);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [editVisit, setEditVisit] = useState<RestaurantVisitRow | null>(null);
  const [deleteVisit, setDeleteVisit] = useState<RestaurantVisitRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["restaurant-visits", page, startDate, endDate],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: "20" });
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
      return api.get<RestaurantVisitsResponse>(`/api/restaurant/visits?${params.toString()}`);
    },
  });

  const addMutation = useMutation({
    mutationFn: (body: {
      customerId: string;
      visitDate: string;
      tableNumber?: string;
      guests: number;
      orderAmount: number;
      foodCategory?: string;
      source: string;
      notes?: string;
    }) => api.post("/api/restaurant/visits", body),
    onSuccess: () => {
      toast({
        title: "Restaurant visit recorded",
        description: "Customer intelligence has been updated.",
      });
      qc.invalidateQueries({ queryKey: ["restaurant-visits"] });
      setShowCreate(false);
    },
    onError: (err: unknown) =>
      toast({
        title: "Could not record visit",
        description: err instanceof ApiError ? err.message : "Could not record visit.",
        variant: "destructive",
      }),
  });

  // Phase 6.4 — edit a visit: loyalty points are compensated automatically.
  const editMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch<{ visit: unknown; loyalty: { pointsDelta: number; balance: number } | null }>(
        `/api/restaurant/visits/${id}`,
        body,
      ),
    onSuccess: (res) => {
      const delta = res.loyalty?.pointsDelta ?? 0;
      toast({
        title: "Visit updated",
        description:
          delta !== 0
            ? `Loyalty points corrected by ${delta > 0 ? "+" : ""}${delta} (new balance ${res.loyalty?.balance ?? 0}).`
            : "No loyalty change was needed.",
      });
      qc.invalidateQueries({ queryKey: ["restaurant-visits"] });
      setEditVisit(null);
    },
    onError: (err: unknown) =>
      toast({
        title: "Could not update visit",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      }),
  });

  // Phase 6.4 — delete a visit: loyalty points are reversed automatically.
  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      api.delete<{ loyalty: { pointsReversed: number; balance: number } | null }>(
        `/api/restaurant/visits/${id}`,
      ),
    onSuccess: (res) => {
      const reversed = res.loyalty?.pointsReversed ?? 0;
      toast({
        title: "Visit deleted",
        description:
          reversed > 0
            ? `${reversed} loyalty points were reversed (new balance ${res.loyalty?.balance ?? 0}).`
            : "No loyalty points had been earned for this visit.",
      });
      qc.invalidateQueries({ queryKey: ["restaurant-visits"] });
      setDeleteVisit(null);
    },
    onError: (err: unknown) =>
      toast({
        title: "Could not delete visit",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      }),
  });

  const visits = data?.visits ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Restaurant Customers"
        description="Walk-in diners, in-house guests, online orders — all tracked here. Each visit grows the customer's restaurant intelligence profile."
        action={
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> Record Visit
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Utensils className="h-3.5 w-3.5" /> Total Visits
            </div>
            <p className="text-2xl font-bold tabular-nums mt-1">{formatNumber(total)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5" /> Customers Tracked
            </div>
            <p className="text-2xl font-bold tabular-nums mt-1">
              {formatNumber(visits.length > 0 ? new Set(visits.map((v) => v.customerId)).size : 0)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <IndianRupee className="h-3.5 w-3.5" /> Total Spend
            </div>
            <p className="text-2xl font-bold tabular-nums mt-1">
              {formatCurrency(visits.reduce((s, v) => s + v.orderAmount, 0))}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">Avg Order</div>
            <p className="text-2xl font-bold tabular-nums mt-1">
              {formatCurrency(
                visits.length ? visits.reduce((s, v) => s + v.orderAmount, 0) / visits.length : 0,
              )}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-4 border-b">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="space-y-1">
              <Label className="text-xs">From</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-[160px]"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-[160px]"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStartDate("");
                setEndDate("");
              }}
            >
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : visits.length === 0 ? (
        <EmptyState
          icon={Utensils}
          title="No restaurant visits yet"
          description="Record your first restaurant visit — the customer's restaurant spend and favourite category will update automatically."
          action={
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> Record First Visit
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Visit Date</TableHead>
                  <TableHead>Table</TableHead>
                  <TableHead>Guests</TableHead>
                  <TableHead>Order Amount</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visits.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell>
                      <div className="font-medium">{v.customer.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {maskPhoneDisplay(v.customer.phone)}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">{formatDateTime(v.visitDate)}</TableCell>
                    <TableCell>{v.tableNumber ?? "—"}</TableCell>
                    <TableCell className="tabular-nums">{v.guests}</TableCell>
                    <TableCell className="font-medium tabular-nums">
                      {formatCurrency(v.orderAmount)}
                    </TableCell>
                    <TableCell>
                      {v.foodCategory && <Badge variant="outline">{v.foodCategory}</Badge>}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{SOURCE_LABELS[v.source] ?? v.source}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          title="Edit visit (loyalty points are corrected automatically)"
                          onClick={() => setEditVisit(v)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          title="Delete visit (loyalty points are reversed automatically)"
                          onClick={() => setDeleteVisit(v)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Page {page} of {totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <AddRestaurantVisitDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onSubmit={(body) => addMutation.mutate(body)}
        loading={addMutation.isPending}
      />

      <EditRestaurantVisitDialog
        visit={editVisit}
        loading={editMutation.isPending}
        onClose={() => setEditVisit(null)}
        onSubmit={(body) => editVisit && editMutation.mutate({ id: editVisit.id, body })}
      />

      <AlertDialog open={Boolean(deleteVisit)} onOpenChange={(o) => !o && setDeleteVisit(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this visit?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteVisit && (
                <>
                  <b>{deleteVisit.customer.name}</b> · {formatCurrency(deleteVisit.orderAmount)} ·{" "}
                  {formatDateTime(deleteVisit.visitDate)}
                  <br />
                  Any loyalty points earned from this visit are automatically reversed (recorded as
                  a reversal entry in the points history — nothing is silently rewritten). This
                  cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (deleteVisit) deleteMutation.mutate(deleteVisit.id);
              }}
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Delete visit
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ================================================================== */
/* Phase 6.4 — Edit visit dialog (loyalty auto-compensation)           */
/* ================================================================== */

function EditRestaurantVisitDialog({
  visit,
  loading,
  onClose,
  onSubmit,
}: {
  visit: RestaurantVisitRow | null;
  loading: boolean;
  onClose: () => void;
  onSubmit: (body: {
    visitDate: string;
    tableNumber?: string;
    guests: number;
    orderAmount: number;
    foodCategory?: string;
    notes?: string;
  }) => void;
}) {
  const [visitDate, setVisitDate] = useState("");
  const [tableNumber, setTableNumber] = useState("");
  const [guests, setGuests] = useState("1");
  const [orderAmount, setOrderAmount] = useState("");
  const [foodCategory, setFoodCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);

  // Hydrate form whenever a different visit is opened.
  if (visit && hydratedFor !== visit.id) {
    setHydratedFor(visit.id);
    setVisitDate(new Date(visit.visitDate).toISOString().slice(0, 16));
    setTableNumber(visit.tableNumber ?? "");
    setGuests(String(visit.guests));
    setOrderAmount(String(visit.orderAmount));
    setFoodCategory(visit.foodCategory ?? "");
    setNotes(visit.notes ?? "");
  }

  function submit() {
    if (!visit) return;
    onSubmit({
      visitDate: new Date(visitDate).toISOString(),
      tableNumber: tableNumber || undefined,
      guests: Number(guests) || 1,
      orderAmount: Number(orderAmount) || 0,
      foodCategory: foodCategory || undefined,
      notes: notes || undefined,
    });
  }

  return (
    <Dialog open={Boolean(visit)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Restaurant Visit</DialogTitle>
          <DialogDescription>
            Correct the bill or details. When the amount changes, loyalty points are adjusted
            automatically — the points history records the correction transparently.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Visit date &amp; time</Label>
              <Input
                type="datetime-local"
                value={visitDate}
                onChange={(e) => setVisitDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Table</Label>
              <Input
                value={tableNumber}
                onChange={(e) => setTableNumber(e.target.value)}
                placeholder="T-12"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Guests</Label>
              <Input
                type="number"
                min={1}
                max={50}
                value={guests}
                onChange={(e) => setGuests(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Order amount (₹)</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={orderAmount}
                onChange={(e) => setOrderAmount(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Food category</Label>
            <Input
              value={foodCategory}
              onChange={(e) => setFoodCategory(e.target.value)}
              placeholder="North Indian, Chinese…"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Special requests, corrections…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={loading || !orderAmount}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddRestaurantVisitDialog({
  open,
  onOpenChange,
  onSubmit,
  loading,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (body: {
    customerId: string;
    visitDate: string;
    tableNumber?: string;
    guests: number;
    orderAmount: number;
    foodCategory?: string;
    source: string;
    notes?: string;
  }) => void;
  loading: boolean;
}) {
  const [customerId, setCustomerId] = useState("");
  const [visitDate, setVisitDate] = useState(new Date().toISOString().slice(0, 16));
  const [tableNumber, setTableNumber] = useState("");
  const [guests, setGuests] = useState("1");
  const [orderAmount, setOrderAmount] = useState("");
  const [foodCategory, setFoodCategory] = useState("");
  const [source, setSource] = useState("WALK_IN");
  const [notes, setNotes] = useState("");

  const { data: customersData } = useQuery({
    queryKey: ["customers-list-all"],
    queryFn: () => api.get<CustomersResponse>("/api/customers?pageSize=50"),
  });

  function submit() {
    onSubmit({
      customerId,
      visitDate: new Date(visitDate).toISOString(),
      tableNumber: tableNumber || undefined,
      guests: Number(guests),
      orderAmount: Number(orderAmount) || 0,
      foodCategory: foodCategory || undefined,
      source,
      notes: notes || undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record Restaurant Visit</DialogTitle>
          <DialogDescription>
            This visit will be added to the customer's restaurant intelligence profile and segments.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Customer</Label>
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a customer" />
              </SelectTrigger>
              <SelectContent>
                {(customersData?.customers ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} · {maskPhoneDisplay(c.phone)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Visit Date & Time</Label>
              <Input
                type="datetime-local"
                value={visitDate}
                onChange={(e) => setVisitDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Table Number</Label>
              <Input
                value={tableNumber}
                onChange={(e) => setTableNumber(e.target.value)}
                placeholder="T-12"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Guests</Label>
              <Input
                type="number"
                value={guests}
                onChange={(e) => setGuests(e.target.value)}
                min={1}
              />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>Order Amount (₹)</Label>
              <Input
                type="number"
                value={orderAmount}
                onChange={(e) => setOrderAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Food Category</Label>
              <Select value={foodCategory} onValueChange={setFoodCategory}>
                <SelectTrigger>
                  <SelectValue placeholder="Optional" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="VEG">Vegetarian</SelectItem>
                  <SelectItem value="NON_VEG">Non-Veg</SelectItem>
                  <SelectItem value="JAIN">Jain</SelectItem>
                  <SelectItem value="VEGAN">Vegan</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Source</Label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(SOURCE_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Special requests, feedback, etc."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={loading || !customerId || !orderAmount}>
            {loading && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Record Visit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

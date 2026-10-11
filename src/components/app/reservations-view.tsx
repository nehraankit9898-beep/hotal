"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { CalendarClock } from "lucide-react";

interface ReservationRow {
  id: string;
  date: string;
  startTime: string;
  durationMinutes: number;
  partySize: number;
  status: string;
  guestName: string;
  guestPhone: string;
  source: string;
  notes: string | null;
  table: { number: string; zone: string | null } | null;
}

const TONE: Record<string, string> = {
  PENDING: "bg-amber-500 hover:bg-amber-500",
  CONFIRMED: "bg-blue-600 hover:bg-blue-600",
  SEATED: "bg-emerald-600 hover:bg-emerald-600",
  COMPLETED: "bg-zinc-600 hover:bg-zinc-600",
  CANCELLED: "bg-red-700 hover:bg-red-700",
  NO_SHOW: "bg-red-700 hover:bg-red-700",
};

/** Phase 16 — reservations (concurrency-safe booking + lifecycle). */
export function ReservationsView() {
  const queryClient = useQueryClient();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [form, setForm] = useState({ tableId: "", guestName: "", guestPhone: "", partySize: "2", startTime: "19:00" });

  const tablesQ = useQuery({
    queryKey: ["tables-for-res"],
    queryFn: async () => (await api.get("/api/tables")) as { tables: { id: string; number: string; capacity: number }[] },
  });
  const resQ = useQuery({
    queryKey: ["reservations", date],
    queryFn: async () => (await api.get(`/api/reservations?date=${date}`)) as { reservations: ReservationRow[] },
  });

  const create = useMutation({
    mutationFn: async () =>
      (await api.post("/api/reservations", {
        tableId: form.tableId || undefined,
        date,
        startTime: form.startTime,
        partySize: Number(form.partySize),
        guestName: form.guestName,
        guestPhone: form.guestPhone,
      })) as Record<string, unknown>,
    onSuccess: () => {
      toast.success("Reservation booked (auto-confirmed).");
      setForm((f) => ({ ...f, guestName: "", guestPhone: "" }));
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const transition = useMutation({
    mutationFn: async (input: { id: string; to: string; reason?: string }) =>
      (await api.patch("/api/reservations", input)) as Record<string, unknown>,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["reservations"] }),
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Reservations"
        description="Overlapping bookings are blocked at the database level — two concurrent requests can never double-book a table."
        action={<Input type="date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} />}
      />

      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Table</label>
            <Select value={form.tableId || "any"} onValueChange={(v) => setForm((f) => ({ ...f, tableId: v === "any" ? "" : v }))}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any</SelectItem>
                {(tablesQ.data?.tables ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.number} (cap {t.capacity})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Guest</label>
            <Input className="w-36" placeholder="Name" value={form.guestName} onChange={(e) => setForm((f) => ({ ...f, guestName: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Phone</label>
            <Input className="w-32" placeholder="Phone" value={form.guestPhone} onChange={(e) => setForm((f) => ({ ...f, guestPhone: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Party</label>
            <Input className="w-16" type="number" min="1" value={form.partySize} onChange={(e) => setForm((f) => ({ ...f, partySize: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Time</label>
            <Input className="w-24" value={form.startTime} onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))} />
          </div>
          <Button onClick={() => create.mutate()} disabled={create.isPending || form.guestName.length < 2 || form.guestPhone.length < 6}>
            <CalendarClock className="h-4 w-4" /> Book
          </Button>
        </CardContent>
      </Card>

      {(resQ.data?.reservations ?? []).length === 0 ? (
        <EmptyState icon={CalendarClock} title="No reservations" description="Bookings for this date appear here." />
      ) : (
        <div className="space-y-2">
          {(resQ.data?.reservations ?? []).map((r) => (
            <Card key={r.id}>
              <CardContent className="p-3 flex flex-wrap items-center gap-3 text-sm">
                <span className="font-semibold">{r.startTime}</span>
                <span>{r.guestName} <span className="text-muted-foreground">({r.partySize} pax)</span></span>
                {r.table && <span className="text-muted-foreground">Table {r.table.number}</span>}
                <Badge className={TONE[r.status] ?? ""}>{r.status.replace("_", " ")}</Badge>
                {r.source === "PUBLIC" && <Badge variant="outline">public request</Badge>}
                <span className="flex-1" />
                {["CONFIRMED", "SEATED", "CANCELLED", "NO_SHOW", "COMPLETED"].map((to) => {
                  const allowed: Record<string, string[]> = {
                    PENDING: ["CONFIRMED", "CANCELLED", "NO_SHOW"],
                    CONFIRMED: ["SEATED", "CANCELLED", "NO_SHOW", "COMPLETED"],
                    SEATED: ["COMPLETED", "CANCELLED"],
                  };
                  if (!(allowed[r.status] ?? []).includes(to)) return null;
                  return (
                    <Button key={to} size="sm" variant="outline" onClick={() => transition.mutate({ id: r.id, to, reason: to === "CANCELLED" ? "changed plans" : undefined })}>
                      {to === "NO_SHOW" ? "No-show" : to.charAt(0) + to.slice(1).toLowerCase()}
                    </Button>
                  );
                })}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

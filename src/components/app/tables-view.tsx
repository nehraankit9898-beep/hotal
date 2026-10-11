"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import QRCode from "qrcode";
import { api } from "@/lib/api-client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { CircleAlert } from "lucide-react";

interface TableRow {
  id: string;
  number: string;
  capacity: number;
  zone: string | null;
  activeSession: { id: string; openedAt: string; guestName: string | null } | null;
  qr: { code: string; url: string } | null;
}

export function TablesView({ user }: { user: { role: string } }) {
  const queryClient = useQueryClient();
  const canManage = ["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER", "RESTAURANT_MANAGER"].includes(user.role);
  const [addOpen, setAddOpen] = useState(false);
  const [qrPreview, setQrPreview] = useState<{ number: string; url: string; dataUrl: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["tables"],
    queryFn: () => api.get<{ tables: TableRow[] }>("/api/tables"),
    refetchInterval: 15_000,
  });

  const regenerateQr = useMutation({
    mutationFn: (id: string) => api.patch(`/api/tables/${id}`, { regenerateQr: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tables"] });
      toast.success("New QR generated — the old printed code has been revoked");
    },
    onError: (e) => toast.error(e.message),
  });

  const archiveTable = useMutation({
    mutationFn: (id: string) => api.delete(`/api/tables/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tables"] });
      toast.success("Table archived — its QR codes are revoked");
    },
    onError: (e) => toast.error(e.message),
  });

  const tables = data?.tables ?? [];

  async function showQr(t: TableRow) {
    if (!t.qr) {
      toast.error("This table has no QR code.");
      return;
    }
    const dataUrl = await QRCode.toDataURL(t.qr.url, { width: 512, margin: 2 });
    setQrPreview({ number: t.number, url: t.qr.url, dataUrl });
  }

  function downloadQr() {
    if (!qrPreview) return;
    const a = document.createElement("a");
    a.href = qrPreview.dataUrl;
    a.download = `restroloop-table-${qrPreview.number}.png`;
    a.click();
  }

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Tables & QR"
        description="Your floor map. Each table gets a unique, revocable QR that diners scan to browse the menu and order."
      />

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {tables.length} active table{tables.length === 1 ? "" : "s"}
        </p>
        {canManage && (
          <Button size="sm" onClick={() => setAddOpen(true)}>
            Add table
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : tables.length === 0 ? (
        <EmptyState
          icon={CircleAlert}
          title="No tables yet"
          description="Add your first table to generate its ordering QR code."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tables.map((t) => (
            <Card key={t.id}>
              <CardContent className="flex h-full flex-col gap-3 p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-lg font-bold">Table {t.number}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.capacity} seats{t.zone ? ` · ${t.zone}` : ""}
                    </p>
                  </div>
                  {t.activeSession ? (
                    <Badge className="bg-emerald-600 hover:bg-emerald-600">Occupied</Badge>
                  ) : (
                    <Badge variant="outline">Free</Badge>
                  )}
                </div>
                {t.activeSession && (
                  <p className="text-xs text-muted-foreground">
                    Since {new Date(t.activeSession.openedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                    {t.activeSession.guestName ? ` · ${t.activeSession.guestName}` : ""}
                  </p>
                )}
                <div className="mt-auto flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => showQr(t)}>
                    Show QR
                  </Button>
                  {canManage && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={regenerateQr.isPending}
                        onClick={() => regenerateQr.mutate(t.id)}
                      >
                        Re-issue QR
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={archiveTable.isPending}
                        onClick={() => {
                          if (confirm(`Archive table ${t.number}? Its QR codes stop working immediately.`)) {
                            archiveTable.mutate(t.id);
                          }
                        }}
                      >
                        Archive
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AddTableDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={() => {
          setAddOpen(false);
          queryClient.invalidateQueries({ queryKey: ["tables"] });
        }}
      />

      <Dialog open={qrPreview !== null} onOpenChange={(v) => !v && setQrPreview(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Table {qrPreview?.number} QR</DialogTitle>
            <DialogDescription>
              Print this and place it on the table. Scanning it opens the live menu bound to this table — the code is
              unpredictable and can be revoked any time.
            </DialogDescription>
          </DialogHeader>
          {qrPreview && (
            <div className="flex flex-col items-center gap-3">
              <img src={qrPreview.dataUrl} alt={`QR code for table ${qrPreview.number}`} className="h-56 w-56" />
              <p className="break-all text-center text-[10px] text-muted-foreground">{qrPreview.url}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setQrPreview(null)}>
              Close
            </Button>
            <Button onClick={downloadQr}>Download PNG</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AddTableDialog(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  // Keyed remount on every open → fresh form state without effect-based resets.
  return <AddTableDialogInner key={props.open ? "open" : "closed"} {...props} />;
}

function AddTableDialogInner({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [number, setNumber] = useState("");
  const [capacity, setCapacity] = useState("4");
  const [zone, setZone] = useState("");

  const save = useMutation({
    mutationFn: () =>
      api.post("/api/tables", {
        number,
        capacity: Number(capacity),
        zone: zone || undefined,
        createQr: true,
      }),
    onSuccess: () => {
      toast.success("Table added with its ordering QR");
      onSaved();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a table</DialogTitle>
          <DialogDescription>
            A fresh ordering QR bound to this table is generated automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="table-number">Table number</Label>
              <Input
                id="table-number"
                value={number}
                onChange={(e) => setNumber(e.target.value.toUpperCase())}
                placeholder="T1"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="table-capacity">Seats</Label>
              <Input id="table-capacity" inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="table-zone">Zone (optional)</Label>
            <Input id="table-zone" value={zone} onChange={(e) => setZone(e.target.value)} placeholder="Garden / Floor 2" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || number.trim().length < 1}>
            Add table
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

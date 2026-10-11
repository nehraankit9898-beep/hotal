"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { QrCodesResponse, QrCodeRow } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime, formatNumber } from "@/lib/format";
import {
  QrCode as QrIcon,
  Plus,
  Loader2,
  Download,
  Printer,
  RefreshCw,
  Power,
  Trash2,
  ExternalLink,
} from "lucide-react";

const TYPE_LABELS: Record<string, string> = {
  MENU: "Menu / About",
  LOYALTY: "Loyalty join",
  FEEDBACK: "Feedback",
  ORDER: "Ordering",
};

export function QrCodesView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [previewOf, setPreviewOf] = useState<QrCodeRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["qr-codes"],
    queryFn: () => api.get<QrCodesResponse>("/api/qr-codes"),
  });

  const createMutation = useMutation({
    mutationFn: (body: { type: string; label: string }) => api.post("/api/qr-codes", body),
    onSuccess: () => {
      toast({ title: "QR code created", description: "Download and print it for your tables." });
      qc.invalidateQueries({ queryKey: ["qr-codes"] });
      setShowCreate(false);
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not create QR",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/api/qr-codes/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["qr-codes"] });
      setPreviewOf(null);
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not update QR",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/qr-codes/${id}`),
    onSuccess: () => {
      toast({ title: "QR code deleted" });
      qc.invalidateQueries({ queryKey: ["qr-codes"] });
      setPreviewOf(null);
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not delete QR",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const codes = data?.qrCodes ?? [];

  return (
    <div className="space-y-6">
      <SectionHeading
        title="QR Codes"
        description="Print these on tables, bills and posters. Customers scan → join, give feedback — no app needed."
        action={
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> New QR Code
          </Button>
        }
      />

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : codes.length === 0 ? (
        <EmptyState
          icon={QrIcon}
          title="No QR codes yet"
          description="Create your first table QR code. Customers scan it to join your loyalty program and leave feedback — instantly, with no app."
          action={
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> Create QR Code
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {codes.map((q) => (
            <Card key={q.id} className="overflow-hidden">
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Badge variant="outline" className="text-[11px]">
                      {TYPE_LABELS[q.type] ?? q.type}
                    </Badge>
                    <p className="mt-2 font-semibold truncate">{q.label ?? "Untitled QR"}</p>
                    <p className="text-xs text-muted-foreground">
                      Created {formatDateTime(q.createdAt)}
                    </p>
                  </div>
                  <Badge
                    variant={q.active ? "default" : "secondary"}
                    className={q.active ? "bg-emerald-600" : ""}
                  >
                    {q.active ? "Active" : "Disabled"}
                  </Badge>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-center">
                  <div className="rounded-lg bg-muted p-2">
                    <p className="text-lg font-bold tabular-nums">{formatNumber(q.scans)}</p>
                    <p className="text-[11px] text-muted-foreground">Scans</p>
                  </div>
                  <div className="rounded-lg bg-muted p-2">
                    <p className="text-lg font-bold tabular-nums">{formatNumber(q.joins)}</p>
                    <p className="text-[11px] text-muted-foreground">Joins</p>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" className="flex-1" onClick={() => downloadQr(q)}>
                    <Download className="h-4 w-4 mr-1" /> PNG
                  </Button>
                  <Button size="sm" variant="outline" className="flex-1" onClick={() => printQr(q)}>
                    <Printer className="h-4 w-4 mr-1" /> Print
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPreviewOf(q)}
                    title="Manage"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New QR code</DialogTitle>
            <DialogDescription>
              Each code is unique and securely identifies your restaurant.
            </DialogDescription>
          </DialogHeader>
          <CreateForm
            submitting={createMutation.isPending}
            onSubmit={(type, label) => createMutation.mutate({ type, label })}
          />
        </DialogContent>
      </Dialog>

      {/* Manage dialog */}
      <Dialog open={!!previewOf} onOpenChange={(o) => !o && setPreviewOf(null)}>
        <DialogContent className="max-w-md">
          {previewOf ? (
            <>
              <DialogHeader>
                <DialogTitle>{previewOf.label ?? "QR code"}</DialogTitle>
                <DialogDescription>
                  {TYPE_LABELS[previewOf.type]} · {previewOf.active ? "Active" : "Disabled"} ·{" "}
                  {previewOf.scans} scans, {previewOf.joins} joins
                  {previewOf.lastScanAt
                    ? ` · last scanned ${formatDateTime(previewOf.lastScanAt)}`
                    : ""}
                </DialogDescription>
              </DialogHeader>
              <div className="flex justify-center rounded-xl border bg-white p-4">
                <QrImage url={previewOf.url} size={180} />
              </div>
              <p className="break-all rounded-lg bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
                {previewOf.url}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" onClick={() => downloadQr(previewOf)}>
                  <Download className="h-4 w-4 mr-1" /> Download
                </Button>
                <Button variant="outline" onClick={() => printQr(previewOf)}>
                  <Printer className="h-4 w-4 mr-1" /> Print
                </Button>
                <Button
                  variant="outline"
                  disabled={patchMutation.isPending}
                  onClick={() =>
                    patchMutation.mutate({ id: previewOf.id, body: { active: !previewOf.active } })
                  }
                >
                  <Power className="h-4 w-4 mr-1" /> {previewOf.active ? "Disable" : "Enable"}
                </Button>
                <Button
                  variant="outline"
                  disabled={patchMutation.isPending}
                  onClick={() => {
                    if (confirm("Regenerate? Old printed codes will STOP working immediately.")) {
                      patchMutation.mutate({ id: previewOf.id, body: { regenerate: true } });
                    }
                  }}
                >
                  <RefreshCw className="h-4 w-4 mr-1" /> Regenerate
                </Button>
              </div>
              <DialogFooter>
                <Button
                  variant="destructive"
                  onClick={() => {
                    if (confirm("Delete this QR code permanently?"))
                      deleteMutation.mutate(previewOf.id);
                  }}
                >
                  <Trash2 className="h-4 w-4 mr-1" /> Delete
                </Button>
                <Button variant="outline" onClick={() => setPreviewOf(null)}>
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreateForm({
  submitting,
  onSubmit,
}: {
  submitting: boolean;
  onSubmit: (type: string, label: string) => void;
}) {
  const [type, setType] = useState("LOYALTY");
  const [label, setLabel] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (label.trim().length >= 2) onSubmit(type, label.trim());
      }}
      className="space-y-3"
    >
      <div>
        <Label>Purpose</Label>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="LOYALTY">Loyalty join (recommended)</SelectItem>
            <SelectItem value="MENU">Menu / About page</SelectItem>
            <SelectItem value="FEEDBACK">Feedback</SelectItem>
            <SelectItem value="ORDER">Ordering</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor="qr-label">Label (e.g. Table 1, Front counter)</Label>
        <Input
          id="qr-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Table 1"
          className="mt-1"
        />
      </div>
      <Button type="submit" className="w-full" disabled={submitting || label.trim().length < 2}>
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Create QR code
      </Button>
    </form>
  );
}

/** Render the QR image into a data URL. */
function QrImage({ url, size }: { url: string; size: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, {
      width: size * 2,
      margin: 2,
      color: { dark: "#111827", light: "#ffffff" },
    })
      .then((d) => {
        if (alive) setSrc(d);
      })
      .catch(() => {
        if (alive) setSrc(null);
      });
    return () => {
      alive = false;
    };
  }, [url, size]);
  return src ? (
    <img src={src} alt={`QR code for ${url}`} width={size} height={size} />
  ) : (
    <Skeleton style={{ width: size, height: size }} />
  );
}

async function makeQrDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url, {
    width: 720,
    margin: 3,
    color: { dark: "#111827", light: "#ffffff" },
  });
}

async function downloadQr(q: QrCodeRow) {
  const dataUrl = await makeQrDataUrl(q.url);
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `stayloop-qr-${q.code.slice(0, 10)}.png`;
  a.click();
}

async function printQr(q: QrCodeRow) {
  const dataUrl = await makeQrDataUrl(q.url);
  const w = window.open("", "_blank", "width=480,height=640");
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>StayLoop QR — ${q.label ?? q.code}</title>
  <style>body{font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;gap:16px}
  h1{font-size:22px;margin:0}p{color:#555;font-size:14px;margin:0}img{width:340px;height:340px}</style></head>
  <body><h1>Scan &amp; Join Rewards</h1><img src="${dataUrl}" alt="QR code"/><p>${q.url}</p>
  </body></html>`);
  w.document.close();
  // SECURITY FIX: no inline <script> inside the new window — it inherits the app's
  // nonce-based CSP and would be blocked. Print from the opener once it has loaded.
  const doPrint = () => setTimeout(() => w.print(), 300);
  if (w.document.readyState === "complete") doPrint();
  else w.addEventListener("load", doPrint, { once: true });
}

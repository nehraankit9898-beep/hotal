"use client";

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { ImportRowCustomer, ImportRowVisit, ImportSummary } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
  Copy,
  Download,
  Loader2,
  RotateCcw,
  AlertTriangle,
  PartyPopper,
  FileText,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const CUSTOMERS_TEMPLATE = `name,phone,email,marketing_consent
Rahul Sharma,+91 98765 43210,rahul@example.com,yes
Priya Patel,+91 91234 56780,priya@example.com,no`;

const VISITS_TEMPLATE = `customer_phone,checkin,checkout
+91 98765 43210,2025-09-14,2025-09-16
+91 91234 56780,2025-09-20,`;

function downloadTemplate(name: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

type Step = "upload" | "preview" | "done";

export function ImportView() {
  return (
    <Tabs defaultValue="customers" className="space-y-5">
      <TabsList className="h-11 p-1">
        <TabsTrigger value="customers" className="px-5 text-[13px] gap-1.5">
          <FileSpreadsheet className="h-4 w-4" /> Customers
        </TabsTrigger>
        <TabsTrigger value="visits" className="px-5 text-[13px] gap-1.5">
          <CalendarIcon /> Visits
        </TabsTrigger>
      </TabsList>
      <TabsContent value="customers">
        <ImportPanel mode="customers" />
      </TabsContent>
      <TabsContent value="visits">
        <ImportPanel mode="visits" />
      </TabsContent>
    </Tabs>
  );
}

function CalendarIcon() {
  return <FileText className="h-4 w-4" />;
}

function ImportPanel({ mode }: { mode: "customers" | "visits" }) {
  const isCustomers = mode === "customers";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [step, setStep] = useState<Step>("upload");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // preview state
  const [customerRows, setCustomerRows] = useState<ImportRowCustomer[]>([]);
  const [visitRows, setVisitRows] = useState<ImportRowVisit[]>([]);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [resultSummary, setResultSummary] = useState<ImportSummary | null>(null);

  const previewMutation = useMutation({
    mutationFn: () =>
      api.post<{ rows: ImportRowCustomer[] | ImportRowVisit[]; summary: ImportSummary }>(
        `/api/imports/${mode}/preview`,
        { csv },
      ),
    onSuccess: (res) => {
      setError(null);
      if (isCustomers) setCustomerRows(res.rows as ImportRowCustomer[]);
      else setVisitRows(res.rows as ImportRowVisit[]);
      setSummary(res.summary);
      setStep("preview");
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Could not preview this file.");
    },
  });

  const importMutation = useMutation({
    mutationFn: () => api.post<{ summary: ImportSummary }>(`/api/imports/${mode}`, { csv }),
    onSuccess: (res) => {
      setResultSummary(res.summary);
      setStep("done");
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["visits"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["audit"] });
      toast({
        title: "Import complete",
        description: `${res.summary.imported} ${isCustomers ? "customers" : "visits"} imported.`,
      });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Import failed. Please try again.");
    },
  });

  function loadFile(file: File) {
    if (file.size > 2_000_000) {
      setError("That file is too large (max 2 MB). Split it into smaller files.");
      return;
    }
    // Bug fix — charset detection: Excel often saves CSVs in Windows-1252
    // (Latin-1) rather than UTF-8. Read as ArrayBuffer and decode strictly;
    // when UTF-8 decoding fails, fall back to windows-1252 so Hindi/accented
    // names do not turn into mojibake.
    const reader = new FileReader();
    reader.onload = () => {
      const buf = reader.result as ArrayBuffer;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        try {
          text = new TextDecoder("windows-1252").decode(buf);
          toast({
            title: "Encoding detected",
            description: "This file is not UTF-8 — it was decoded as Windows-1252 (Excel export).",
          });
        } catch {
          setError(
            "Could not read this file. Please save it as UTF-8 CSV from Excel (File → Save As → CSV UTF-8).",
          );
          return;
        }
      }
      setCsv(text);
      setFileName(file.name);
      setError(null);
      previewMutation.mutate();
    };
    reader.onerror = () => {
      setError("Could not read that file. Try again or paste the CSV text directly.");
    };
    reader.readAsArrayBuffer(file);
  }

  function reset() {
    setCsv("");
    setFileName("");
    setStep("upload");
    setPasteOpen(false);
    setError(null);
    setSummary(null);
    setResultSummary(null);
    setCustomerRows([]);
    setVisitRows([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const template = isCustomers ? CUSTOMERS_TEMPLATE : VISITS_TEMPLATE;
  const validCount = summary ? Math.max(0, summary.total - summary.invalid) : 0;
  const invalidCount = summary?.invalid ?? 0;
  const dupCount = (summary as ImportSummary & { duplicates?: number })?.duplicates ?? 0;

  return (
    <div className="space-y-5">
      {/* Steps indicator */}
      <div className="flex items-center gap-2 text-xs font-medium">
        {[
          { id: "upload", label: isCustomers ? "Upload customer CSV" : "Upload visit CSV" },
          { id: "preview", label: "Preview & validate" },
          { id: "done", label: "Import results" },
        ].map((s, i) => (
          <div key={s.id} className="flex items-center gap-2">
            <div
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-bold",
                step === s.id ||
                  (s.id === "preview" && step === "done") ||
                  (s.id === "upload" && step !== "upload")
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground",
              )}
            >
              {i + 1}
            </div>
            <span className={cn(step === s.id ? "text-foreground" : "text-muted-foreground")}>
              {s.label}
            </span>
            {i < 2 && <div className="w-6 h-px bg-border" />}
          </div>
        ))}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* STEP 1: Upload */}
      {step === "upload" && (
        <div className="space-y-4">
          <div
            className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-primary/35 bg-primary/[0.03] px-6 py-12 text-center cursor-pointer hover:border-primary/60 hover:bg-primary/[0.06] transition-colors"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) loadFile(f);
            }}
            role="button"
            tabIndex={0}
            aria-label="Upload CSV file"
            onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary mb-4">
              <Upload className="h-7 w-7" />
            </div>
            <p className="text-[15px] font-semibold">
              {previewMutation.isPending
                ? "Validating your file…"
                : "Drop your CSV here, or click to browse"}
            </p>
            <p className="mt-1.5 text-sm text-muted-foreground max-w-md">
              {isCustomers
                ? "Expected columns: name, phone, email, marketing_consent — first row must be the header."
                : "Expected columns: customer_phone, checkin, checkout — customers must already exist."}
            </p>
            {previewMutation.isPending && (
              <Loader2 className="h-5 w-5 animate-spin text-primary mt-4" />
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) loadFile(f);
            }}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadTemplate(
                  isCustomers ? "customers-template.csv" : "visits-template.csv",
                  template,
                )
              }
            >
              <Download className="h-4 w-4" /> Download template
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPasteOpen((p) => !p)}>
              <Copy className="h-4 w-4" /> Paste CSV text
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCsv(template);
                setFileName("sample.csv");
                previewMutation.mutate();
              }}
            >
              <FileText className="h-4 w-4" /> Try sample data
            </Button>
          </div>

          {pasteOpen && (
            <div className="space-y-3 rounded-xl border bg-card p-4">
              <textarea
                className="w-full h-36 rounded-lg border bg-background p-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={template}
                onChange={(e) => setCsv(e.target.value)}
                value={csv}
                aria-label="Paste CSV content"
              />
              <Button
                size="sm"
                disabled={!csv.trim() || previewMutation.isPending}
                onClick={() => previewMutation.mutate()}
              >
                {previewMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Validating…
                  </>
                ) : (
                  "Validate & preview"
                )}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* STEP 2: Preview */}
      {step === "preview" && summary && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="secondary" className="gap-1.5 py-1.5 px-3">
              <FileSpreadsheet className="h-3.5 w-3.5" /> {fileName || "Pasted data"} ·{" "}
              {summary.total} rows
            </Badge>
            <Badge className="gap-1.5 py-1.5 px-3 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border-0">
              <CheckCircle2 className="h-3.5 w-3.5" /> {validCount} ready to import
            </Badge>
            {isCustomers && dupCount > 0 && (
              <Badge className="gap-1.5 py-1.5 px-3 bg-amber-500/12 text-amber-600 dark:text-amber-400 border-0">
                <Copy className="h-3.5 w-3.5" /> {dupCount} duplicates (skipped)
              </Badge>
            )}
            {invalidCount > 0 && (
              <Badge className="gap-1.5 py-1.5 px-3 bg-rose-500/12 text-rose-600 dark:text-rose-400 border-0">
                <XCircle className="h-3.5 w-3.5" /> {invalidCount} invalid
              </Badge>
            )}
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" onClick={reset}>
                <RotateCcw className="h-4 w-4" /> Start over
              </Button>
              <Button
                size="sm"
                disabled={validCount === 0 || importMutation.isPending}
                onClick={() => importMutation.mutate()}
              >
                {importMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Importing…
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" /> Import {validCount}{" "}
                    {isCustomers ? "customers" : "visits"}
                  </>
                )}
              </Button>
            </div>
          </div>

          <div className="rounded-xl border bg-card overflow-hidden">
            <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10">
                  <TableRow className="bg-accent hover:bg-accent">
                    <TableHead className="w-[60px]">Row</TableHead>
                    {isCustomers ? (
                      <>
                        <TableHead>Name</TableHead>
                        <TableHead>Phone</TableHead>
                        <TableHead className="hidden sm:table-cell">Email</TableHead>
                        <TableHead>Consent</TableHead>
                      </>
                    ) : (
                      <>
                        <TableHead>Customer</TableHead>
                        <TableHead>Phone</TableHead>
                        <TableHead>Check-in</TableHead>
                        <TableHead>Check-out</TableHead>
                      </>
                    )}
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isCustomers
                    ? customerRows.map((r) => (
                        <RowRenderer
                          key={r.row}
                          status={r.status}
                          reason={r.reason}
                          cells={[
                            r.name || "—",
                            r.phone || "—",
                            r.email || "—",
                            r.consent ? "Yes" : "No",
                          ]}
                          hideCells={[2]}
                        />
                      ))
                    : visitRows.map((r) => (
                        <RowRenderer
                          key={r.row}
                          status={r.status}
                          reason={r.reason}
                          cells={[
                            r.customerName || r.customerPhone,
                            r.customerPhone,
                            r.checkin,
                            r.checkout || "—",
                          ]}
                          hideCells={[]}
                        />
                      ))}
                </TableBody>
              </Table>
            </div>
          </div>

          {invalidCount > 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                Invalid rows are <span className="font-semibold">never silently discarded</span> —
                they are listed above with the exact reason. Fix them in your CSV and re-upload, or
                import only the valid rows.
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}

      {/* STEP 3: Done */}
      {step === "done" && resultSummary && (
        <div className="rounded-2xl border bg-card p-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-600">
            <PartyPopper className="h-7 w-7" />
          </div>
          <h3 className="text-lg font-bold">Import complete</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {isCustomers
              ? "Your customer list has been updated."
              : "Visit records have been added."}
          </p>

          <div className="mx-auto mt-6 grid max-w-md grid-cols-3 gap-3">
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/25 p-4">
              <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                {resultSummary.imported}
              </p>
              <p className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400 mt-0.5">
                Imported
              </p>
            </div>
            {isCustomers && (
              <div className="rounded-xl bg-amber-500/10 border border-amber-500/25 p-4">
                <p className="text-2xl font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                  {resultSummary.duplicates ?? 0}
                </p>
                <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400 mt-0.5">
                  Duplicates
                </p>
              </div>
            )}
            <div className="rounded-xl bg-rose-500/10 border border-rose-500/25 p-4">
              <p className="text-2xl font-bold text-rose-600 dark:text-rose-400 tabular-nums">
                {resultSummary.invalid}
              </p>
              <p className="text-[11px] font-medium text-rose-700 dark:text-rose-400 mt-0.5">
                Failed
              </p>
            </div>
          </div>

          <Button className="mt-6" variant="outline" onClick={reset}>
            <RotateCcw className="h-4 w-4" /> Import another file
          </Button>
        </div>
      )}
    </div>
  );
}

function RowRenderer({
  status,
  reason,
  cells,
  hideCells,
}: {
  status: string;
  reason?: string;
  cells: string[];
  hideCells: number[];
}) {
  return (
    <TableRow
      className={cn(
        status === "invalid" && "bg-rose-500/[0.04] hover:bg-rose-500/[0.06]",
        status === "duplicate" && "bg-amber-500/[0.04] hover:bg-amber-500/[0.06]",
      )}
    >
      {cells.map((c, i) => (
        <TableCell
          key={i}
          className={cn(
            "text-[12.5px]",
            hideCells.includes(i) && "hidden sm:table-cell",
            i === 0 && "font-semibold",
          )}
        >
          {c}
        </TableCell>
      ))}
      <TableCell>
        {status === "valid" ? (
          <Badge className="bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border-0 gap-1">
            <CheckCircle2 className="h-3 w-3" /> Ready
          </Badge>
        ) : status === "duplicate" ? (
          <div>
            <Badge className="bg-amber-500/12 text-amber-600 dark:text-amber-400 border-0 gap-1">
              <Copy className="h-3 w-3" /> Duplicate
            </Badge>
            {reason && (
              <p className="mt-1 text-[10.5px] text-muted-foreground max-w-[220px]">{reason}</p>
            )}
          </div>
        ) : (
          <div>
            <Badge className="bg-rose-500/12 text-rose-600 dark:text-rose-400 border-0 gap-1">
              <XCircle className="h-3 w-3" /> Invalid
            </Badge>
            {reason && (
              <p className="mt-1 text-[10.5px] text-muted-foreground max-w-[220px]">{reason}</p>
            )}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { CustomersResponse, CustomerRow, ViewId } from "@/lib/types";
import { CustomerDialog } from "./customer-dialog";
import { VisitDialog } from "./visit-dialog";
import { EmptyState } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Search,
  UserPlus,
  MoreHorizontal,
  Eye,
  EyeOff,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  CalendarCheck,
  Pencil,
  UserRoundX,
  UserRoundCheck,
  BellRing,
  BellOff,
  Users,
  Loader2,
  Crown,
  Download,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDate, initials, maskPhoneDisplay, phoneDisplay, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Download the customers CSV export. Handles both flows from
 * GET /api/export/customers: inline CSV (≤5000 rows) and the async job
 * flow (202 + jobId → poll → signed download token).
 */
async function triggerCustomersExport(): Promise<void> {
  const token = (() => {
    try {
      return localStorage.getItem("stayloop_session_token");
    } catch {
      return null;
    }
  })();
  const res = await fetch("/api/export/customers", {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (res.status === 202) {
    // Async export: poll the job until COMPLETED, then download via token.
    const queued = (await res.json()) as { jobId: string; message?: string };
    const jobId = queued.jobId;
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      const jobRes = await fetch(`/api/jobs/${jobId}`, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!jobRes.ok) throw new Error("The export job could not be tracked. Please try again.");
      const data = (await jobRes.json()) as {
        job?: { status: string; result?: { downloadToken?: string; filename?: string } };
        status?: string;
        result?: { downloadToken?: string; filename?: string };
      };
      const job = data.job ?? { status: data.status ?? "", result: data.result };
      if (job.status === "COMPLETED" && job.result?.downloadToken) {
        window.open(
          `/api/jobs/${jobId}/download?token=${encodeURIComponent(job.result.downloadToken)}`,
          "_blank",
        );
        return;
      }
      if (job.status === "FAILED")
        throw new Error("The export failed on the server. Please try again.");
    }
    throw new Error(
      "The export is taking longer than expected. Check Audit Logs or retry in a minute.",
    );
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(data?.error?.message || "Export failed. Please try again.");
  }

  // Inline CSV — hand it to the browser as a file download.
  const csv = await res.text();
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `stayloop-customers-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

type SortField = "created" | "name" | "visits" | "last_visit";

function SortIcon({
  field,
  sort,
  order,
}: {
  field: SortField;
  sort: SortField;
  order: "asc" | "desc";
}) {
  if (sort !== field) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
  return order === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
}

export function CustomersView({
  onOpenCustomer,
  setView,
}: {
  onOpenCustomer: (id: string) => void;
  setView: (v: ViewId) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // --- Filters state ---
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [consent, setConsent] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState<SortField>("created");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [showPhones, setShowPhones] = useState(false);

  // --- Dialogs ---
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CustomerRow | null>(null);
  const [visitFor, setVisitFor] = useState<CustomerRow | null>(null);
  const [visitOpen, setVisitOpen] = useState(false);
  const [deactivating, setDeactivating] = useState<CustomerRow | null>(null);
  const [consentAction, setConsentAction] = useState<{
    customer: CustomerRow;
    mode: "opt_in" | "opt_out";
  } | null>(null);
  const [exporting, setExporting] = useState(false);

  // Debounce search
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 350);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [searchInput]);

  const queryKey = useMemo(
    () => ["customers", { search, consent, status, sort, order, page }] as const,
    [search, consent, status, sort, order, page],
  );

  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams({
        q: search,
        consent,
        status,
        sort,
        order,
        page: String(page),
        pageSize: "10",
      });
      return api.get<CustomersResponse>(`/api/customers?${params.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  // Filter/sort changes always return to page 1 (event handlers, not effects)
  function changeConsent(v: string) {
    setConsent(v);
    setPage(1);
  }
  function changeStatus(v: string) {
    setStatus(v);
    setPage(1);
  }
  function clearFilters() {
    setSearchInput("");
    setConsent("all");
    setStatus("all");
    setPage(1);
  }

  function toggleSort(field: SortField) {
    if (sort === field) {
      setOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSort(field);
      setOrder(field === "name" ? "asc" : "desc");
    }
    setPage(1);
  }

  // Mutations
  const deactivateMutation = useMutation({
    mutationFn: (c: CustomerRow) => api.delete(`/api/customers/${c.id}`),
    onSuccess: (_, c) => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["audit"] });
      toast({ title: "Customer deactivated", description: `${c.name} is now marked inactive.` });
      setDeactivating(null);
    },
    onError: (err) => {
      toast({
        title: "Could not deactivate",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: (c: CustomerRow) => api.patch(`/api/customers/${c.id}`, { status: "ACTIVE" }),
    onSuccess: (_, c) => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast({ title: "Customer reactivated", description: `${c.name} is active again.` });
    },
    onError: (err) => {
      toast({
        title: "Could not reactivate",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const consentMutation = useMutation({
    mutationFn: ({ customer, mode }: { customer: CustomerRow; mode: "opt_in" | "opt_out" }) =>
      api.post(`/api/customers/${customer.id}/${mode === "opt_in" ? "consent" : "opt-out"}`),
    onSuccess: (_, { customer, mode }) => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["customer"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["audit"] });
      toast({
        title: mode === "opt_in" ? "Consent recorded" : "Opt-out recorded",
        description:
          mode === "opt_in"
            ? `${customer.name} agreed to receive marketing offers.`
            : `${customer.name} will not receive marketing messages.`,
      });
      setConsentAction(null);
    },
    onError: (err) => {
      toast({
        title: "Could not update consent",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const customers = data?.customers ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, phone or email…"
            className="pl-10"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search customers"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={consent} onValueChange={changeConsent}>
            <SelectTrigger className="w-[150px]" aria-label="Filter by consent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All consent</SelectItem>
              <SelectItem value="opted_in">Opted in</SelectItem>
              <SelectItem value="opted_out">Opted out</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={changeStatus}>
            <SelectTrigger className="w-[130px]" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setShowPhones((s) => !s)}
            aria-label={showPhones ? "Hide phone numbers" : "Show phone numbers"}
            title={showPhones ? "Hide phone numbers" : "Show phone numbers"}
          >
            {showPhones ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          <Button
            variant="outline"
            disabled={exporting}
            onClick={async () => {
              setExporting(true);
              try {
                await triggerCustomersExport();
                toast({
                  title: "Export ready",
                  description: "Your customer CSV download has started.",
                });
              } catch (err) {
                toast({
                  title: "Export failed",
                  description: err instanceof Error ? err.message : "Please try again.",
                  variant: "destructive",
                });
              } finally {
                setExporting(false);
              }
            }}
            aria-label="Export customers to CSV"
            title="Export all customers to CSV"
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">Export</span>
          </Button>
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <UserPlus className="h-4 w-4" /> Add customer
          </Button>
        </div>
      </div>

      {/* Result count */}
      <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
        <p>
          {total > 0 ? (
            <>
              Showing{" "}
              <span className="font-semibold text-foreground">
                {(page - 1) * 10 + 1}–{Math.min(page * 10, total)}
              </span>{" "}
              of <span className="font-semibold text-foreground">{formatNumber(total)}</span>{" "}
              {total === 1 ? "customer" : "customers"}
            </>
          ) : (
            "No customers to show"
          )}
          {isFetching && !isLoading && <Loader2 className="inline ml-2 h-3 w-3 animate-spin" />}
        </p>
        {search && (
          <button
            className="hover:text-foreground underline underline-offset-2"
            onClick={() => setSearchInput("")}
          >
            Clear search
          </button>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="rounded-xl border bg-card">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 border-b last:border-0 px-4 py-3.5">
              <Skeleton className="h-9 w-9 rounded-full" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-28 ml-auto" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={Users}
          title="Couldn't load customers"
          description="Something went wrong while fetching your guest list."
          action={<Button onClick={() => refetch()}>Try again</Button>}
        />
      ) : customers.length === 0 ? (
        <EmptyState
          icon={search || consent !== "all" || status !== "all" ? Search : Users}
          title={
            search || consent !== "all" || status !== "all"
              ? "No matching customers"
              : "No customers yet"
          }
          description={
            search || consent !== "all" || status !== "all"
              ? "Try a different search term or clear the filters."
              : "Add your first guest manually, or import your whole guest list from a CSV file."
          }
          action={
            search || consent !== "all" || status !== "all" ? (
              <Button variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    setEditing(null);
                    setDialogOpen(true);
                  }}
                >
                  <UserPlus className="h-4 w-4" /> Add customer
                </Button>
                <Button variant="outline" onClick={() => setView("import")}>
                  Import CSV
                </Button>
              </div>
            )
          }
        />
      ) : (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-accent/40 hover:bg-accent/40">
                  <TableHead className="w-[40px]"></TableHead>
                  <TableHead>
                    <button
                      className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors font-semibold"
                      onClick={() => toggleSort("name")}
                    >
                      Customer <SortIcon field="name" sort={sort} order={order} />
                    </button>
                  </TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead className="hidden md:table-cell">Email</TableHead>
                  <TableHead>
                    <button
                      className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors font-semibold"
                      onClick={() => toggleSort("visits")}
                    >
                      Visits <SortIcon field="visits" sort={sort} order={order} />
                    </button>
                  </TableHead>
                  <TableHead className="hidden sm:table-cell">
                    <button
                      className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors font-semibold"
                      onClick={() => toggleSort("last_visit")}
                    >
                      Last visit <SortIcon field="last_visit" sort={sort} order={order} />
                    </button>
                  </TableHead>
                  <TableHead>Consent</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Spend</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((c) => (
                  <TableRow
                    key={c.id}
                    className="cursor-pointer"
                    onClick={() => onOpenCustomer(c.id)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Avatar className="h-9 w-9">
                        <AvatarFallback
                          className={cn(
                            "text-[11px] font-bold",
                            c.status === "ACTIVE"
                              ? "bg-primary/10 text-primary"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          {initials(c.name)}
                        </AvatarFallback>
                      </Avatar>
                    </TableCell>
                    <TableCell className="max-w-[180px]">
                      <p className="truncate font-semibold text-[13.5px] flex items-center gap-1">
                        {c.name}
                        {c.vip && <Crown className="h-3 w-3 text-amber-500" aria-label="VIP" />}
                      </p>
                      <p className="text-[11px] text-muted-foreground md:hidden">
                        {showPhones ? phoneDisplay(c.phone) : maskPhoneDisplay(c.phone)}
                      </p>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell font-mono text-[12.5px] text-muted-foreground">
                      {showPhones ? phoneDisplay(c.phone) : maskPhoneDisplay(c.phone)}
                    </TableCell>
                    <TableCell className="hidden md:table-cell max-w-[170px]">
                      <p className="truncate text-[12.5px] text-muted-foreground">
                        {c.email || "—"}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={cn(
                          "tabular-nums font-semibold",
                          c.totalVisits >= 3 &&
                            "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
                          c.totalVisits === 0 && "bg-muted text-muted-foreground",
                        )}
                      >
                        {c.totalVisits}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-[12.5px] text-muted-foreground">
                      {formatDate(c.lastVisit)}
                    </TableCell>
                    <TableCell>
                      {c.optOut ? (
                        <Badge className="bg-rose-500/12 text-rose-600 dark:text-rose-400 hover:bg-rose-500/12 border-0">
                          <BellOff className="h-3 w-3 mr-1" /> Opted out
                        </Badge>
                      ) : c.marketingConsent ? (
                        <Badge className="bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/12 border-0">
                          <BellRing className="h-3 w-3 mr-1" /> Opted in
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-muted-foreground">
                          No consent
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          c.status === "ACTIVE"
                            ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400 bg-emerald-500/5"
                            : "border-muted-foreground/30 text-muted-foreground",
                        )}
                      >
                        {c.status === "ACTIVE" ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-[12.5px] tabular-nums font-medium">
                      {c.totalSpend != null && c.totalSpend > 0
                        ? `₹${c.totalSpend.toLocaleString("en-IN")}`
                        : "—"}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label={`Actions for ${c.name}`}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuLabel className="text-xs">{c.name}</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => onOpenCustomer(c.id)}>
                            <Eye className="h-4 w-4" /> View profile
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              setEditing(c);
                              setDialogOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4" /> Edit details
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              setVisitFor(c);
                              setVisitOpen(true);
                            }}
                          >
                            <CalendarCheck className="h-4 w-4" /> Add visit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {c.optOut || !c.marketingConsent ? (
                            <DropdownMenuItem
                              onClick={() => setConsentAction({ customer: c, mode: "opt_in" })}
                            >
                              <BellRing className="h-4 w-4" /> Record marketing consent
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onClick={() => setConsentAction({ customer: c, mode: "opt_out" })}
                            >
                              <BellOff className="h-4 w-4" /> Opt out of marketing
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          {c.status === "ACTIVE" ? (
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => setDeactivating(c)}
                            >
                              <UserRoundX className="h-4 w-4" /> Deactivate customer
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onClick={() => reactivateMutation.mutate(c)}>
                              <UserRoundCheck className="h-4 w-4" /> Reactivate customer
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t bg-accent/20 px-4 py-3">
              <p className="text-xs text-muted-foreground">
                Page <span className="font-semibold text-foreground">{page}</span> of {totalPages}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  <ChevronLeft className="h-4 w-4" /> Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                >
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Dialogs */}
      <CustomerDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} />
      <VisitDialog open={visitOpen} onOpenChange={setVisitOpen} presetCustomer={visitFor} />

      {/* Deactivate confirm */}
      <AlertDialog open={!!deactivating} onOpenChange={(o) => !o && setDeactivating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {deactivating?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The customer will be hidden from your active list and excluded from future campaigns.
              Their visits and history are kept. You can reactivate anytime.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => deactivating && deactivateMutation.mutate(deactivating)}
            >
              {deactivateMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Yes, deactivate"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Consent confirm */}
      <AlertDialog open={!!consentAction} onOpenChange={(o) => !o && setConsentAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {consentAction?.mode === "opt_in"
                ? `Record marketing consent for ${consentAction?.customer.name}?`
                : `Opt ${consentAction?.customer.name} out of marketing?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {consentAction?.mode === "opt_in"
                ? "Confirm that this guest has agreed to receive promotional offers and updates from your hotel."
                : "The guest will stop receiving all promotional messages. Their consent flag will be cleared and opt-out recorded."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={consentMutation.isPending}
              onClick={() => consentAction && consentMutation.mutate(consentAction)}
            >
              {consentMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : consentAction?.mode === "opt_in" ? (
                "Yes, record consent"
              ) : (
                "Yes, opt out"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

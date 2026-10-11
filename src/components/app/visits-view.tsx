"use client";

import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { VisitsResponse, VisitRow } from "@/lib/types";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  CalendarCheck,
  Search,
  Plus,
  Pencil,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Import,
  UserRound,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime, formatNumber, maskPhoneDisplay } from "@/lib/format";

export function VisitsView({ onOpenCustomer }: { onOpenCustomer: (id: string) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<VisitRow | null>(null);
  const [deleting, setDeleting] = useState<VisitRow | null>(null);

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

  // Date filter changes reset page via handlers (no effects)
  function changeFrom(v: string) {
    setFrom(v);
    setPage(1);
  }
  function changeTo(v: string) {
    setTo(v);
    setPage(1);
  }
  function clearAllFilters() {
    setSearchInput("");
    setFrom("");
    setTo("");
    setPage(1);
  }

  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: ["visits", { search, from, to, page }],
    queryFn: () => {
      const params = new URLSearchParams({
        q: search,
        page: String(page),
        pageSize: "10",
      });
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      return api.get<VisitsResponse>(`/api/visits?${params.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  const deleteMutation = useMutation({
    mutationFn: (v: VisitRow) => api.delete(`/api/visits/${v.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["visits"] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["customer"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["audit"] });
      toast({ title: "Visit deleted", description: "The record was removed." });
      setDeleting(null);
    },
    onError: (err) => {
      toast({
        title: "Could not delete visit",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const visits = data?.visits ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const hasFilters = !!search || !!from || !!to;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by guest name or phone…"
            className="pl-10"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search visits"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              className="w-[145px]"
              value={from}
              onChange={(e) => changeFrom(e.target.value)}
              aria-label="From date"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              className="w-[145px]"
              value={to}
              onChange={(e) => changeTo(e.target.value)}
              aria-label="To date"
            />
          </div>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearAllFilters}>
              Clear
            </Button>
          )}
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="h-4 w-4" /> Record visit
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
        <p>
          {total > 0 ? (
            <>
              Showing{" "}
              <span className="font-semibold text-foreground">
                {(page - 1) * 10 + 1}–{Math.min(page * 10, total)}
              </span>{" "}
              of <span className="font-semibold text-foreground">{formatNumber(total)}</span> visits
            </>
          ) : (
            "No visits to show"
          )}
          {isFetching && !isLoading && <Loader2 className="inline ml-2 h-3 w-3 animate-spin" />}
        </p>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="rounded-xl border bg-card">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 border-b last:border-0 px-4 py-3.5">
              <Skeleton className="h-9 w-9 rounded-full" />
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-4 w-44 ml-auto" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={CalendarCheck}
          title="Couldn't load visits"
          description="Something went wrong while fetching visits."
          action={<Button onClick={() => refetch()}>Try again</Button>}
        />
      ) : visits.length === 0 ? (
        <EmptyState
          icon={hasFilters ? Search : CalendarCheck}
          title={hasFilters ? "No matching visits" : "No visits recorded yet"}
          description={
            hasFilters
              ? "Try different search terms or a wider date range."
              : "Record a guest's visit to start tracking their loyalty journey."
          }
          action={
            hasFilters ? (
              <Button variant="outline" onClick={clearAllFilters}>
                Clear filters
              </Button>
            ) : (
              <Button
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                <Plus className="h-4 w-4" /> Record first visit
              </Button>
            )
          }
        />
      ) : (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-accent/40 hover:bg-accent/40">
                  <TableHead>Guest</TableHead>
                  <TableHead className="hidden sm:table-cell">Phone</TableHead>
                  <TableHead>Check-in</TableHead>
                  <TableHead>Check-out</TableHead>
                  <TableHead className="hidden md:table-cell">Source</TableHead>
                  <TableHead className="hidden lg:table-cell">Notes</TableHead>
                  <TableHead className="w-[90px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visits.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell>
                      <button
                        className="inline-flex items-center gap-2.5 text-left hover:underline underline-offset-4"
                        onClick={() => v.customerId && onOpenCustomer(v.customerId)}
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                          <UserRound className="h-4 w-4" />
                        </div>
                        <span className="font-semibold text-[13.5px] truncate max-w-[150px]">
                          {v.customerName}
                        </span>
                      </button>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell font-mono text-[12.5px] text-muted-foreground">
                      {maskPhoneDisplay(v.customerPhone || "")}
                    </TableCell>
                    <TableCell className="text-[12.5px]">{formatDateTime(v.checkin)}</TableCell>
                    <TableCell className="text-[12.5px] text-muted-foreground">
                      {v.checkout ? formatDateTime(v.checkout) : "—"}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {v.source === "CSV_IMPORT" ? (
                        <Badge variant="secondary" className="text-[10.5px] gap-1">
                          <Import className="h-3 w-3" /> CSV
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10.5px]">
                          Manual
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell max-w-[220px]">
                      <p className="truncate text-[12.5px] text-muted-foreground">
                        {v.notes || "—"}
                      </p>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label="Edit visit"
                          onClick={() => {
                            setEditing(v);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          aria-label="Delete visit"
                          onClick={() => setDeleting(v)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

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

      <VisitDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this visit?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && (
                <>
                  <span className="font-medium">{deleting.customerName}</span>&apos;s visit on{" "}
                  <span className="font-medium">{formatDateTime(deleting.checkin)}</span> will be
                  permanently removed. Visit counts will update automatically.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleting) deleteMutation.mutate(deleting);
              }}
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Trash2 className="h-4 w-4" /> Delete visit
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { AuditLogsResponse } from "@/lib/types";
import { EmptyState } from "./shared-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { ScrollText, ChevronLeft, ChevronRight, UserRound, ShieldCheck } from "lucide-react";
import { formatDateTime, AUDIT_LABELS } from "@/lib/format";
import { cn } from "@/lib/utils";

const ACTION_OPTIONS = [
  { value: "all", label: "All actions" },
  { value: "LOGIN", label: "Sign-ins" },
  { value: "LOGIN_FAILED", label: "Failed sign-ins" },
  { value: "LOGOUT", label: "Sign-outs" },
  { value: "CUSTOMER_CREATED", label: "Customer added" },
  { value: "CUSTOMER_UPDATED", label: "Customer updated" },
  { value: "CUSTOMER_DEACTIVATED", label: "Customer deactivated" },
  { value: "CONSENT_GRANTED", label: "Consent given" },
  { value: "OPT_OUT", label: "Marketing opt-out" },
  { value: "VISIT_CREATED", label: "Visit recorded" },
  { value: "VISIT_UPDATED", label: "Visit updated" },
  { value: "VISIT_DELETED", label: "Visit deleted" },
  { value: "CUSTOMERS_IMPORTED", label: "Customers imported" },
  { value: "VISITS_IMPORTED", label: "Visits imported" },
  { value: "PASSWORD_CHANGED", label: "Password changed" },
];

const ACTION_TONES: Record<string, string> = {
  LOGIN: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
  LOGIN_FAILED: "bg-rose-500/12 text-rose-600 dark:text-rose-400",
  CONSENT_GRANTED: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
  OPT_OUT: "bg-rose-500/12 text-rose-600 dark:text-rose-400",
  CUSTOMER_DEACTIVATED: "bg-rose-500/12 text-rose-600 dark:text-rose-400",
  VISIT_CREATED: "bg-amber-500/12 text-amber-600 dark:text-amber-400",
  VISIT_DELETED: "bg-rose-500/12 text-rose-600 dark:text-rose-400",
  CUSTOMERS_IMPORTED: "bg-primary/12 text-primary",
  VISITS_IMPORTED: "bg-primary/12 text-primary",
};

export function AuditView() {
  const [action, setAction] = useState("all");
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["audit", { action, page }],
    queryFn: () =>
      api.get<AuditLogsResponse>(`/api/audit-logs?action=${action}&page=${page}&pageSize=15`),
    placeholderData: keepPreviousData,
  });

  const logs = data?.logs ?? [];
  const totalPages = data?.totalPages ?? 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={action}
          onValueChange={(v) => {
            setAction(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[210px]" aria-label="Filter audit action">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTION_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="ml-auto text-xs text-muted-foreground flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" />
          {data?.total ?? 0} recorded actions for your hotel
        </p>
      </div>

      {isLoading ? (
        <div className="rounded-xl border bg-card">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 border-b last:border-0 px-4 py-3.5">
              <Skeleton className="h-5 w-28" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-32 ml-auto" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={ScrollText}
          title="Couldn't load audit logs"
          description="Something went wrong while fetching the audit trail."
          action={<Button onClick={() => refetch()}>Try again</Button>}
        />
      ) : logs.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="No audit entries yet"
          description="Actions like sign-ins, customer changes, and consent updates will appear here automatically."
        />
      ) : (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-accent/40 hover:bg-accent/40">
                  <TableHead>Action</TableHead>
                  <TableHead className="hidden sm:table-cell">Performed by</TableHead>
                  <TableHead className="hidden lg:table-cell">Entity</TableHead>
                  <TableHead className="hidden md:table-cell">Details</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((l) => {
                  let meta: Record<string, unknown> = {};
                  try {
                    meta = l.metadata ? JSON.parse(l.metadata) : {};
                  } catch {
                    meta = {};
                  }
                  const detailParts = Object.entries(meta)
                    .filter(([k]) => !["password"].includes(k))
                    .map(([k, v]) => `${k}: ${String(v)}`)
                    .join(" · ");
                  return (
                    <TableRow key={l.id}>
                      <TableCell>
                        <Badge
                          className={cn(
                            "border-0 font-medium",
                            ACTION_TONES[l.action] || "bg-muted text-muted-foreground",
                          )}
                        >
                          {AUDIT_LABELS[l.action] || l.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <span className="inline-flex items-center gap-2 text-[13px]">
                          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted">
                            <UserRound className="h-3 w-3 text-muted-foreground" />
                          </div>
                          <span className="truncate max-w-[140px]">{l.user?.name || "System"}</span>
                        </span>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-[12.5px] text-muted-foreground">
                        {l.entityType || "—"}
                      </TableCell>
                      <TableCell className="hidden md:table-cell max-w-[240px]">
                        <p className="truncate text-[12px] text-muted-foreground font-mono">
                          {detailParts || "—"}
                        </p>
                      </TableCell>
                      <TableCell className="text-[12.5px] text-muted-foreground whitespace-nowrap">
                        {formatDateTime(l.createdAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
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
    </div>
  );
}

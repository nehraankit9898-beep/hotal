"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/app/shared-ui";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Bell, BellRing, CheckCheck, AlertTriangle, Info, XCircle, Flame } from "lucide-react";

interface NotificationRow {
  id: string;
  level: "INFO" | "WARNING" | "ERROR" | "CRITICAL";
  title: string;
  message: string;
  read: boolean;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

interface NotificationsResponse {
  notifications: NotificationRow[];
  unreadCount: number;
}

const LEVEL_STYLE: Record<
  string,
  { badge: string; icon: React.ComponentType<{ className?: string }> }
> = {
  INFO: { badge: "bg-sky-500/12 text-sky-600 dark:text-sky-400 border-0", icon: Info },
  WARNING: {
    badge: "bg-amber-500/12 text-amber-600 dark:text-amber-400 border-0",
    icon: AlertTriangle,
  },
  ERROR: { badge: "bg-rose-500/12 text-rose-600 dark:text-rose-400 border-0", icon: XCircle },
  CRITICAL: { badge: "bg-rose-600/15 text-rose-700 dark:text-rose-300 border-0", icon: Flame },
};

export function NotificationsView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<NotificationsResponse>("/api/notifications"),
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.put(`/api/notifications?id=${encodeURIComponent(id)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
    onError: () => toast({ title: "Could not mark as read", variant: "destructive" }),
  });

  const markAllRead = useMutation({
    mutationFn: () => api.delete("/api/notifications"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
    onError: () => toast({ title: "Could not mark all as read", variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <EmptyState
        icon={Bell}
        title="Notifications unavailable"
        description="We could not load your notifications. Please refresh the page and try again."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant="secondary" className="gap-1.5 py-1.5 px-3">
          <Bell className="h-3.5 w-3.5" />
          {data.notifications.length} total
        </Badge>
        {data.unreadCount > 0 && (
          <Badge className="gap-1.5 py-1.5 px-3 bg-primary/10 text-primary border-0">
            <BellRing className="h-3.5 w-3.5" /> {data.unreadCount} unread
          </Badge>
        )}
        {data.unreadCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={markAllRead.isPending}
            onClick={() => markAllRead.mutate()}
          >
            <CheckCheck className="h-4 w-4" /> Mark all read
          </Button>
        )}
      </div>

      {data.notifications.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="No notifications yet"
          description="Important alerts about your customers, campaigns and leads will appear here."
        />
      ) : (
        <div className="space-y-2">
          {data.notifications.map((n) => {
            const style = LEVEL_STYLE[n.level] ?? LEVEL_STYLE.INFO;
            const Icon = style.icon;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => !n.read && markRead.mutate(n.id)}
                className={cn(
                  "w-full text-left rounded-xl border bg-card p-4 transition-colors",
                  !n.read && "border-primary/35 bg-primary/[0.04] hover:bg-primary/[0.07]",
                  n.read && "opacity-75 hover:opacity-100",
                )}
                aria-label={n.read ? n.title : `Mark "${n.title}" as read`}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                      style.badge,
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={cn("text-[13.5px]", n.read ? "font-medium" : "font-bold")}>
                        {n.title}
                      </p>
                      <Badge variant="outline" className={cn("text-[9.5px] px-1.5", style.badge)}>
                        {n.level}
                      </Badge>
                      {!n.read && (
                        <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-label="Unread" />
                      )}
                    </div>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                      {n.message}
                    </p>
                    <p className="mt-1.5 text-[11px] text-muted-foreground/70">
                      {formatDateTime(n.createdAt)}
                    </p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

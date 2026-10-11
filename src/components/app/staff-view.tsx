"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { ROLE_LABELS } from "@/lib/types";
import type { AppRole } from "@/lib/types";
import { UserPlus, ShieldOff, KeyRound, RefreshCw } from "lucide-react";

interface StaffRow {
  id: string;
  name: string;
  email: string;
  role: AppRole;
  status: "ACTIVE" | "SUSPENDED" | "PENDING";
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  pendingActivation: boolean;
}

const ASSIGNABLE: { value: string; label: string }[] = [
  { value: "HOTEL_MANAGER", label: ROLE_LABELS.HOTEL_MANAGER },
  { value: "MARKETING_MANAGER", label: ROLE_LABELS.MARKETING_MANAGER },
  { value: "RESTAURANT_MANAGER", label: ROLE_LABELS.RESTAURANT_MANAGER },
  { value: "FRONT_DESK", label: ROLE_LABELS.FRONT_DESK },
  { value: "WAITER", label: ROLE_LABELS.WAITER },
  { value: "CASHIER", label: ROLE_LABELS.CASHIER },
  { value: "KITCHEN_STAFF", label: ROLE_LABELS.KITCHEN_STAFF },
  { value: "HOTEL_STAFF", label: ROLE_LABELS.HOTEL_STAFF },
  { value: "HOTEL_ADMIN", label: ROLE_LABELS.HOTEL_ADMIN },
];

export function StaffView({ user }: { user: { role: string } }) {
  const queryClient = useQueryClient();
  const canManage = ["HOTEL_OWNER", "HOTEL_ADMIN"].includes(user.role);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["staff"],
    queryFn: () => api.get<{ staff: StaffRow[] }>("/api/staff"),
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/api/staff/${id}`, body),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["staff"] });
      const action = vars.body.role !== undefined ? "Role updated" : vars.body.deactivate ? "Staff member deactivated" : vars.body.reactivate ? "Staff member reactivated" : vars.body.revokeSessions ? "Sessions revoked" : "Updated";
      toast.success(action);
    },
    onError: (e) => toast.error(e.message),
  });

  const resetInvite = useMutation({
    mutationFn: (id: string) =>
      api.patch<{ invitation: { url: string } }>(`/api/staff/${id}`, { resetInvite: true }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["staff"] });
      if (data.invitation?.url) setInviteUrl(data.invitation.url);
      toast.success("A fresh one-time invitation link was issued");
    },
    onError: (e) => toast.error(e.message),
  });

  const staff = data?.staff ?? [];

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Staff"
        description="Invite your team with the right role. Kitchen staff see only the kitchen queue; waiters run the floor; cashiers see billing context."
      />

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {staff.length} account{staff.length === 1 ? "" : "s"}
        </p>
        {canManage && (
          <Button size="sm" onClick={() => setInviteOpen(true)}>
            <UserPlus className="mr-1.5 h-4 w-4" /> Invite staff
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : staff.length === 0 ? (
        <EmptyState icon={UserPlus} title="No staff accounts" description="Invite waiters, kitchen and cashier staff to run the floor." />
      ) : (
        <div className="space-y-3">
          {staff.map((member) => (
            <Card key={member.id}>
              <CardContent className="flex flex-wrap items-center gap-4 p-5">
                <div className="min-w-48 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">{member.name}</p>
                    {member.status === "PENDING" && <Badge variant="outline">Invited — not activated</Badge>}
                    {member.status === "SUSPENDED" && <Badge variant="destructive">Deactivated</Badge>}
                    {member.status === "ACTIVE" && <Badge className="bg-emerald-600 hover:bg-emerald-600">Active</Badge>}
                    {member.mfaEnabled && <Badge variant="secondary">MFA on</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">{member.email}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {ROLE_LABELS[member.role] ?? member.role}
                    {member.lastLoginAt
                      ? ` · last login ${new Date(member.lastLoginAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}`
                      : " · never signed in"}
                  </p>
                </div>

                {canManage && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      value={member.role}
                      onValueChange={(role) => update.mutate({ id: member.id, body: { role } })}
                      disabled={update.isPending || member.id === (user as { userId?: string }).userId}
                    >
                      <SelectTrigger className="h-9 w-48" aria-label={`Role for ${member.name}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ASSIGNABLE.map((r) => (
                          <SelectItem key={r.value} value={r.value}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {member.status === "PENDING" && (
                      <Button size="sm" variant="outline" disabled={resetInvite.isPending} onClick={() => resetInvite.mutate(member.id)}>
                        <RefreshCw className="mr-1 h-3.5 w-3.5" /> Re-invite
                      </Button>
                    )}
                    {member.status === "ACTIVE" && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: member.id, body: { revokeSessions: true } })}>
                          <KeyRound className="mr-1 h-3.5 w-3.5" /> Revoke sessions
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => {
                            if (confirm(`Deactivate ${member.name}? Their sessions end immediately.`)) {
                              update.mutate({ id: member.id, body: { deactivate: true } });
                            }
                          }}
                        >
                          <ShieldOff className="mr-1 h-3.5 w-3.5" /> Deactivate
                        </Button>
                      </>
                    )}
                    {member.status === "SUSPENDED" && (
                      <Button size="sm" variant="outline" onClick={() => update.mutate({ id: member.id, body: { reactivate: true } })}>
                        Reactivate
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={(url) => {
          setInviteOpen(false);
          setInviteUrl(url);
          queryClient.invalidateQueries({ queryKey: ["staff"] });
        }}
      />

      <Dialog open={inviteUrl !== null} onOpenChange={(v) => !v && setInviteUrl(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>One-time invitation link</DialogTitle>
            <DialogDescription>
              Share this link with your staff member now — it expires in 72 hours, works once, and is shown only this
              time. They choose their own password when they activate.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-muted px-3 py-2">
            <p className="break-all font-mono text-xs">{inviteUrl}</p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (inviteUrl) {
                  void navigator.clipboard.writeText(inviteUrl);
                  toast.success("Link copied");
                }
              }}
            >
              Copy link
            </Button>
            <Button onClick={() => setInviteUrl(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onInvited: (inviteUrl: string) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("WAITER");

  const invite = useMutation({
    mutationFn: () => api.post<{ invitation: { url: string } }>("/api/staff", { name, email, role }),
    onSuccess: (data) => {
      toast.success("Invitation created");
      onInvited(data.invitation.url);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a staff member</DialogTitle>
          <DialogDescription>
            They receive a one-time activation link and set their own password. No shared or default passwords.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="staff-name">Name</Label>
            <Input id="staff-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ravi Kumar" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="staff-email">Email</Label>
            <Input id="staff-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ravi@restaurant.com" />
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSIGNABLE.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => invite.mutate()}
            disabled={invite.isPending || name.trim().length < 2 || !email.includes("@")}
          >
            Create invitation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

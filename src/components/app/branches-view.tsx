"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, SectionHeading, StatCard } from "@/components/app/shared-ui";
import { Building2, IndianRupee, Users, Package } from "lucide-react";

const rupees = (minor: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(minor / 100);

interface BranchRow {
  hotelId: string;
  name: string;
  city: string | null;
  isMine: boolean;
  bills: number;
  netSalesMinor: number;
  refundMinor: number;
  customers: number;
  lowStock: number;
}
interface BranchData {
  group: { id: string; name: string } | null;
  branches: BranchRow[];
  totals: { bills: number; netSalesMinor: number; refundMinor: number; customers: number; lowStock: number };
}

/** Phase 16 — multi-branch consolidated dashboard (owner groups). */
export function BranchesView() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");

  const dataQ = useQuery({
    queryKey: ["branches"],
    queryFn: async () => (await api.get("/api/branches")) as BranchData,
  });

  const createGroup = useMutation({
    mutationFn: async () => (await api.post("/api/branches", { name })) as Record<string, unknown>,
    onSuccess: () => {
      toast.success("Branch group created with your current restaurant.");
      setName("");
      queryClient.invalidateQueries({ queryKey: ["branches"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const data = dataQ.data;

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Branch dashboard"
        description="Consolidated view across your branch group. Branches you are not owner/admin of are never included."
      />

      {!data?.group ? (
        <Card>
          <CardContent className="p-4 flex flex-wrap items-end gap-3">
            <p className="text-sm text-muted-foreground flex-1">
              Your restaurant is not part of a branch group yet. Create one to get a consolidated owner view.
            </p>
            <Input className="w-56" placeholder="Group name, e.g. Grand Palace Group" value={name} onChange={(e) => setName(e.target.value)} />
            <Button disabled={createGroup.isPending || name.trim().length < 2} onClick={() => createGroup.mutate()}>
              <Building2 className="h-4 w-4" /> Create group
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <StatCard title="Branches" value={data.branches.length} icon={Building2} />
            <StatCard title="Group net sales" value={rupees(data.totals.netSalesMinor)} icon={IndianRupee} tone="emerald" />
            <StatCard title="Customers" value={data.totals.customers} icon={Users} />
            <StatCard title="Low-stock alerts" value={data.totals.lowStock} icon={Package} tone="amber" />
          </div>
          <div className="space-y-2">
            {data.branches.map((b) => (
              <Card key={b.hotelId}>
                <CardContent className="p-4 flex flex-wrap items-center gap-4 text-sm">
                  <span className="font-semibold">{b.name}{b.isMine && <Badge className="ml-2" variant="outline">this branch</Badge>}</span>
                  {b.city && <span className="text-muted-foreground">{b.city}</span>}
                  <span className="flex-1" />
                  <span>{b.bills} bills</span>
                  <span className="font-semibold">{rupees(b.netSalesMinor)}</span>
                  {b.refundMinor > 0 && <span className="text-orange-600 text-xs">refunds {rupees(b.refundMinor)}</span>}
                  <span className="text-muted-foreground">{b.customers} customers</span>
                  {b.lowStock > 0 && <Badge variant="destructive">{b.lowStock} low stock</Badge>}
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { CouponRow } from "@/lib/types";
import type { CouponsResponse } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime, formatNumber, formatCurrency } from "@/lib/format";
import { Ticket, Plus, Loader2, Sparkles } from "lucide-react";

const DISCOUNT_TYPE_LABELS: Record<string, string> = {
  PERCENTAGE: "Percentage",
  FIXED_AMOUNT: "Fixed Amount",
  CUSTOMER_SPECIFIC: "Customer-Specific",
  ONE_TIME: "One-Time",
};

export function CouponsView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["coupons"],
    queryFn: () => api.get<CouponsResponse>("/api/coupons"),
  });

  const createMutation = useMutation({
    mutationFn: (body: {
      code: string;
      description: string;
      discountType: CouponRow["discountType"];
      discountValue: number;
      minimumOrder?: number;
      maximumDiscount?: number;
      usageLimit: number;
      customerLimit: number;
      active: boolean;
    }) => api.post<{ coupon: CouponRow }>("/api/coupons", body),
    onSuccess: () => {
      toast({
        title: "Coupon created",
        description: "The coupon is now active and ready to be redeemed.",
      });
      qc.invalidateQueries({ queryKey: ["coupons"] });
      setShowCreate(false);
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not create coupon",
        description: err instanceof ApiError ? err.message : "Could not create coupon.",
        variant: "destructive",
      });
    },
  });

  const coupons = data?.coupons ?? [];

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Coupons & Offers"
        description="Issue discount coupons, track redemptions, and measure campaign revenue attribution."
        action={
          <Button onClick={() => setShowCreate(true)} size="sm">
            <Plus className="h-4 w-4 mr-1.5" /> New Coupon
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total Coupons</p>
            <p className="text-2xl font-bold tabular-nums">{coupons.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Active Coupons</p>
            <p className="text-2xl font-bold tabular-nums">
              {coupons.filter((c) => c.active).length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total Redemptions</p>
            <p className="text-2xl font-bold tabular-nums">
              {formatNumber(coupons.reduce((s, c) => s + c.totalRedemptions, 0))}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total Discount Issued</p>
            <p className="text-2xl font-bold tabular-nums">
              {formatCurrency(coupons.reduce((s, c) => s + c.totalDiscount, 0))}
            </p>
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : coupons.length === 0 ? (
        <EmptyState
          icon={Ticket}
          title="No coupons yet"
          description="Create your first coupon — it will be available for redemption immediately and tracked through attribution."
          action={
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> Create Coupon
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Validity</TableHead>
                  <TableHead>Usage</TableHead>
                  <TableHead>Discount Issued</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {coupons.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <div className="font-mono font-semibold">{c.code}</div>
                      {c.description && (
                        <div className="text-xs text-muted-foreground">{c.description}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{DISCOUNT_TYPE_LABELS[c.discountType]}</Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      {c.discountType === "PERCENTAGE"
                        ? `${c.discountValue}%`
                        : formatCurrency(c.discountValue)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {c.validFrom && `From ${formatDateTime(c.validFrom)}`}
                      {c.validUntil && ` until ${formatDateTime(c.validUntil)}`}
                      {!c.validFrom && !c.validUntil && "No expiry"}
                    </TableCell>
                    <TableCell>
                      <span className="font-medium tabular-nums">{c.totalRedemptions}</span>
                      {c.usageLimit > 0 && (
                        <span className="text-xs text-muted-foreground"> / {c.usageLimit}</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatCurrency(c.totalDiscount)}
                    </TableCell>
                    <TableCell>
                      {c.active ? (
                        <Badge variant="default" className="bg-emerald-500/15 text-emerald-600">
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Inactive</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <CreateCouponDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onSubmit={(body) => createMutation.mutate(body)}
        loading={createMutation.isPending}
      />
    </div>
  );
}

function CreateCouponDialog({
  open,
  onOpenChange,
  onSubmit,
  loading,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (body: {
    code: string;
    description: string;
    discountType: CouponRow["discountType"];
    discountValue: number;
    minimumOrder?: number;
    maximumDiscount?: number;
    usageLimit: number;
    customerLimit: number;
    active: boolean;
  }) => void;
  loading: boolean;
}) {
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [discountType, setDiscountType] = useState<
    "PERCENTAGE" | "FIXED_AMOUNT" | "CUSTOMER_SPECIFIC" | "ONE_TIME"
  >("PERCENTAGE");
  const [discountValue, setDiscountValue] = useState("10");
  const [minimumOrder, setMinimumOrder] = useState("");
  const [maximumDiscount, setMaximumDiscount] = useState("");
  const [usageLimit, setUsageLimit] = useState("100");
  const [customerLimit, setCustomerLimit] = useState("1");
  const [active, setActive] = useState(true);

  function handleSuggest() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "STAY-";
    for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
    setCode(out);
  }

  function submit() {
    onSubmit({
      code,
      description,
      discountType,
      discountValue: Number(discountValue),
      minimumOrder: minimumOrder ? Number(minimumOrder) : undefined,
      maximumDiscount: maximumDiscount ? Number(maximumDiscount) : undefined,
      usageLimit: Number(usageLimit),
      customerLimit: Number(customerLimit),
      active,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Coupon</DialogTitle>
          <DialogDescription>
            Coupons are validated and redeemed through real backend logic.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Coupon Code</Label>
            <div className="flex gap-2">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="STAY-DIWALI20"
              />
              <Button variant="outline" type="button" onClick={handleSuggest} title="Suggest code">
                <Sparkles className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Description (optional)</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Diwali 20% off returning customers"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Discount Type</Label>
              <Select
                value={discountType}
                onValueChange={(v) => setDiscountType(v as CouponRow["discountType"])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PERCENTAGE">Percentage (%)</SelectItem>
                  <SelectItem value="FIXED_AMOUNT">Fixed Amount (₹)</SelectItem>
                  <SelectItem value="CUSTOMER_SPECIFIC">Customer-Specific</SelectItem>
                  <SelectItem value="ONE_TIME">One-Time Use</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{discountType === "PERCENTAGE" ? "Percentage (%)" : "Amount (₹)"}</Label>
              <Input
                type="number"
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Minimum Order (₹)</Label>
              <Input
                type="number"
                value={minimumOrder}
                onChange={(e) => setMinimumOrder(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Max Discount (₹)</Label>
              <Input
                type="number"
                value={maximumDiscount}
                onChange={(e) => setMaximumDiscount(e.target.value)}
                placeholder="No cap"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Total Usage Limit</Label>
              <Input
                type="number"
                value={usageLimit}
                onChange={(e) => setUsageLimit(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Per-Customer Limit</Label>
              <Input
                type="number"
                value={customerLimit}
                onChange={(e) => setCustomerLimit(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={active} onCheckedChange={setActive} id="active" />
            <Label htmlFor="active">Active and redeemable</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={loading || code.length < 4}>
            {loading && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Create Coupon
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

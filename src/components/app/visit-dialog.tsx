"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { CustomerRow, CustomersResponse, VisitRow } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import { toDatetimeLocal, initials, maskPhoneDisplay } from "@/lib/format";
import { CalendarCheck, Loader2, ChevronsUpDown, Check, UserRound } from "lucide-react";

/**
 * Dialog content unmounts on close (Radix), so form state naturally
 * resets each time the dialog is opened — no effects needed.
 */
export function VisitDialog({
  open,
  onOpenChange,
  editing,
  presetCustomer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: VisitRow | null;
  presetCustomer?: CustomerRow | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <VisitForm
          editing={editing ?? null}
          presetCustomer={presetCustomer ?? null}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}

function VisitForm({
  editing,
  presetCustomer,
  onOpenChange,
}: {
  editing: VisitRow | null;
  presetCustomer: CustomerRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const isEdit = !!editing;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [customerId, setCustomerId] = useState(editing?.customerId ?? presetCustomer?.id ?? "");
  const [customerLabel, setCustomerLabel] = useState(
    editing?.customerName ?? presetCustomer?.name ?? "",
  );
  const [checkin, setCheckin] = useState(() => {
    if (editing) return toDatetimeLocal(editing.checkin);
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  });
  const [checkout, setCheckout] = useState(toDatetimeLocal(editing?.checkout ?? null));
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [amount, setAmount] = useState(editing?.amount != null ? String(editing.amount) : "");
  const [error, setError] = useState<string | null>(null);
  const [comboOpen, setComboOpen] = useState(false);
  const [search, setSearch] = useState("");

  // Customer search (only when no preset + not editing)
  const needsCustomerPick = !isEdit && !presetCustomer;
  const { data: customersData, isLoading: customersLoading } = useQuery({
    queryKey: ["customers", "combo", search],
    queryFn: () =>
      api.get<CustomersResponse>(
        `/api/customers?q=${encodeURIComponent(search)}&pageSize=20&sort=name&order=asc`,
      ),
    enabled: comboOpen && needsCustomerPick,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      if (isEdit) {
        return api.patch(`/api/visits/${editing!.id}`, {
          checkin: new Date(checkin).toISOString(),
          checkout: checkout ? new Date(checkout).toISOString() : null,
          notes,
          amount: amount === "" ? null : Number(amount),
        });
      }
      return api.post(`/api/customers/${customerId}/visits`, {
        checkin: new Date(checkin).toISOString(),
        checkout: checkout ? new Date(checkout).toISOString() : null,
        notes,
        amount: amount === "" ? undefined : Number(amount),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["visits"] });
      queryClient.invalidateQueries({ queryKey: ["customer"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["audit"] });
      toast({
        title: isEdit ? "Visit updated" : "Visit recorded",
        description: isEdit
          ? "The visit details were saved."
          : `${customerLabel}'s visit has been recorded.`,
      });
      onOpenChange(false);
    },
    onError: (err) => {
      setError(
        err instanceof ApiError ? err.message : "Visit could not be saved. Please try again.",
      );
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isEdit && !customerId) {
      setError("Please select which customer visited.");
      return;
    }
    mutation.mutate();
  }

  const options = useMemo(() => customersData?.customers ?? [], [customersData]);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <CalendarCheck className="h-4 w-4 text-primary" />
          {isEdit ? "Edit visit" : "Record a visit"}
        </DialogTitle>
        <DialogDescription>
          {isEdit
            ? "Correct the details of this recorded visit."
            : "Log a guest's stay or walk-in visit."}
        </DialogDescription>
      </DialogHeader>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Customer picker */}
        {isEdit || presetCustomer ? (
          <div className="space-y-2">
            <Label>Customer</Label>
            <div className="flex items-center gap-3 rounded-lg border bg-accent/30 px-3 py-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary text-[11px] font-bold">
                {initials(customerLabel)}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{customerLabel}</p>
                {presetCustomer?.phone && (
                  <p className="text-xs text-muted-foreground">
                    {maskPhoneDisplay(presetCustomer.phone)}
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <Label>Customer *</Label>
            <Popover
              open={comboOpen}
              onOpenChange={(o) => {
                setComboOpen(o);
                if (!o) setSearch("");
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  role="combobox"
                  aria-expanded={comboOpen}
                  className="w-full justify-between font-normal"
                >
                  {customerId ? (
                    <span className="truncate">{customerLabel}</span>
                  ) : (
                    <span className="text-muted-foreground">Search customer…</span>
                  )}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[380px] p-0" align="start">
                <Command shouldFilter={false}>
                  <CommandInput
                    placeholder="Type a name or phone…"
                    value={search}
                    onValueChange={setSearch}
                  />
                  <CommandList>
                    {customersLoading ? (
                      <div className="p-3 space-y-2">
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-2/3" />
                      </div>
                    ) : (
                      <>
                        <CommandEmpty>No customers found. Add the customer first.</CommandEmpty>
                        <CommandGroup>
                          {options.map((c) => (
                            <CommandItem
                              key={c.id}
                              value={c.id}
                              onSelect={() => {
                                setCustomerId(c.id);
                                setCustomerLabel(c.name);
                                setComboOpen(false);
                              }}
                            >
                              <UserRound className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="flex-1 truncate">{c.name}</span>
                              <span className="text-[11px] text-muted-foreground">
                                {maskPhoneDisplay(c.phone)}
                              </span>
                              <Check
                                className={`h-3.5 w-3.5 ${customerId === c.id ? "opacity-100" : "opacity-0"}`}
                              />
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="v-checkin">Check-in *</Label>
            <Input
              id="v-checkin"
              type="datetime-local"
              value={checkin}
              onChange={(e) => setCheckin(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="v-checkout">Check-out</Label>
            <Input
              id="v-checkout"
              type="datetime-local"
              value={checkout}
              onChange={(e) => setCheckout(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="v-notes">Notes (optional)</Label>
          <Textarea
            id="v-notes"
            placeholder="e.g. Room 204 · Suite upgrade · Anniversary stay"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="resize-none"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="v-amount">Total spend for this stay (₹, optional)</Label>
          <Input
            id="v-amount"
            type="number"
            min="0"
            step="1"
            placeholder="e.g. 4500"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">
            Spending powers VIP / High-Value segments and campaign revenue analytics.
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Saving…
              </>
            ) : isEdit ? (
              "Save changes"
            ) : (
              "Record visit"
            )}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

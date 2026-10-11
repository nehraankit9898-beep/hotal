"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/format";
import {
  KeyRound,
  Plus,
  Trash2,
  Copy,
  Check,
  Code2,
  AlertTriangle,
  Loader2,
  Terminal,
  BookOpen,
  Lock,
} from "lucide-react";

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: string;
  requests: number;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

interface ApiKeysResponse {
  apiAccess: boolean;
  keys: ApiKeyRow[];
}

const ENDPOINTS: { method: string; path: string; scope: string; description: string }[] = [
  { method: "GET", path: "/api/v1", scope: "read", description: "Endpoint index & API metadata" },
  {
    method: "GET",
    path: "/api/v1/customers",
    scope: "read",
    description: "List customers — ?q=&page=&pageSize=",
  },
  {
    method: "POST",
    path: "/api/v1/customers",
    scope: "write",
    description: "Create a customer — { name, phone, email?, marketingConsent? }",
  },
  {
    method: "GET",
    path: "/api/v1/customers/{id}",
    scope: "read",
    description: "One customer with their last 10 visits",
  },
  {
    method: "GET",
    path: "/api/v1/visits",
    scope: "read",
    description: "List visits — ?phone=&page=&pageSize=",
  },
  {
    method: "POST",
    path: "/api/v1/visits",
    scope: "write",
    description: "Record a visit — { phone, checkin, checkout?, amount? }",
  },
  {
    method: "GET",
    path: "/api/v1/loyalty",
    scope: "read",
    description: "Loyalty points & tier — ?phone=",
  },
  {
    method: "GET",
    path: "/api/v1/stats",
    scope: "read",
    description: "Hotel totals: customers, visits, active campaigns",
  },
];

function methodBadge(method: string) {
  const cls =
    method === "GET"
      ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border-0"
      : method === "POST"
        ? "bg-amber-500/12 text-amber-600 dark:text-amber-400 border-0"
        : "bg-rose-500/12 text-rose-600 dark:text-rose-400 border-0";
  return (
    <Badge className={`${cls} font-mono text-[10.5px] w-[52px] justify-center`}>{method}</Badge>
  );
}

export function DeveloperView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newWrite, setNewWrite] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api.get<ApiKeysResponse>("/api/api-keys"),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<{ secret: string }>("/api/api-keys", {
        name: newName.trim(),
        scopes: newWrite ? ["read", "write"] : ["read"],
      }),
    onSuccess: (res) => {
      setCreatedSecret(res.secret);
      setCreateOpen(false);
      setNewName("");
      setNewWrite(false);
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (err) =>
      toast({
        title: "Could not create key",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      }),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/api-keys/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      toast({ title: "Key revoked", description: "The API key can no longer be used." });
    },
    onError: (err) =>
      toast({
        title: "Could not revoke key",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      }),
  });

  const baseUrl = useMemo(() => {
    if (typeof window === "undefined") return "https://your-domain.com";
    return window.location.origin;
  }, []);

  const curlExample = `curl -X POST ${baseUrl}/api/v1/customers \\
  -H "Authorization: Bearer sk_live_xxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Rahul Sharma","phone":"+91 98765 43210","marketingConsent":true}'`;

  const curlVisit = `curl "${baseUrl}/api/v1/visits?phone=%2B919876543210" \\
  -H "Authorization: Bearer sk_live_xxxxxxxxxxxx"`;

  return (
    <div className="space-y-6">
      {/* Plan gate notice */}
      {data && !data.apiAccess && (
        <Alert className="border-amber-500/40 bg-amber-500/[0.06]">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertDescription className="text-[13px]">
            Developer API access is{" "}
            <span className="font-semibold">not included in your current plan</span>. Upgrade your
            plan (Billing &amp; Plan → see plans) to create API keys and connect your POS, booking
            engine or custom apps.
          </AlertDescription>
        </Alert>
      )}

      {/* Keys card */}
      <div className="rounded-xl border bg-card">
        <div className="flex flex-wrap items-center gap-3 border-b px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <KeyRound className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-bold">API Keys</h2>
            <p className="text-xs text-muted-foreground">
              Server-to-server keys for the StayLoop v1 API. Keys are shown once at creation.
            </p>
          </div>
          <Button
            size="sm"
            disabled={createMutation.isPending || (!!data && !data.apiAccess)}
            onClick={() => {
              setCreatedSecret(null);
              setCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4" /> Create key
          </Button>
        </div>

        <div className="p-2">
          {isLoading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : isError ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              Could not load API keys.
            </p>
          ) : !data || data.keys.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted">
                <Code2 className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-semibold">No API keys yet</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                Create a key to let your POS, booking engine, website or custom app read and write
                StayLoop data securely.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Key</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead className="hidden md:table-cell">Requests</TableHead>
                  <TableHead className="hidden lg:table-cell">Last used</TableHead>
                  <TableHead className="hidden sm:table-cell">Created</TableHead>
                  <TableHead className="w-[70px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.keys.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell className="font-semibold text-[13px]">
                      <div className="flex items-center gap-2">
                        {k.name}
                        {k.status === "REVOKED" && (
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 text-rose-600 border-rose-300 dark:border-rose-800"
                          >
                            Revoked
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell font-mono text-[11.5px] text-muted-foreground">
                      {k.prefix}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {k.scopes.map((s) => (
                          <Badge
                            key={s}
                            variant="secondary"
                            className="text-[10px] px-1.5 font-mono"
                          >
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell tabular-nums text-[12.5px]">
                      {k.requests.toLocaleString()}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-[12px] text-muted-foreground">
                      {k.lastUsedAt ? formatDate(k.lastUsedAt) : "Never"}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-[12px] text-muted-foreground">
                      {formatDate(k.createdAt)}
                    </TableCell>
                    <TableCell>
                      {k.status === "ACTIVE" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          aria-label={`Revoke ${k.name}`}
                          title="Revoke key"
                          disabled={revokeMutation.isPending}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Revoke "${k.name}"? Any app using this key will stop working immediately.`,
                              )
                            ) {
                              revokeMutation.mutate(k.id);
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      {/* Docs card */}
      <div className="rounded-xl border bg-card">
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <BookOpen className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-bold">API Reference</h2>
            <p className="text-xs text-muted-foreground">
              REST endpoints under <code className="font-mono">{baseUrl}/api/v1</code>
            </p>
          </div>
        </div>

        <div className="grid gap-0 md:grid-cols-2">
          <div className="p-5 md:border-r">
            <h3 className="mb-3 flex items-center gap-2 text-[13px] font-bold">
              <Lock className="h-3.5 w-3.5 text-muted-foreground" /> Authentication
            </h3>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              Send your key with every request. Keys are scoped:{" "}
              <code className="font-mono text-[11px]">read</code> for GET endpoints,{" "}
              <code className="font-mono text-[11px]">write</code> for POST. Rate limit: 120
              requests per minute per key. Every response is JSON — success{" "}
              <code className="font-mono text-[11px]">{`{ data }`}</code>, error{" "}
              <code className="font-mono text-[11px]">{`{ error: { code, message } }`}</code>.
            </p>
            <div className="mt-3 rounded-lg bg-muted p-3 font-mono text-[11.5px] leading-relaxed">
              Authorization: Bearer sk_live_…
              <br />
              <span className="text-muted-foreground">— or —</span>
              <br />
              X-API-Key: sk_live_…
            </div>

            <h3 className="mb-3 mt-5 flex items-center gap-2 text-[13px] font-bold">
              <Terminal className="h-3.5 w-3.5 text-muted-foreground" /> Example: create a customer
            </h3>
            <div className="relative rounded-lg bg-zinc-950 p-3.5 font-mono text-[11.5px] leading-relaxed text-zinc-200 overflow-x-auto">
              <pre className="whitespace-pre">{curlExample}</pre>
              <button
                type="button"
                className="absolute right-2 top-2 rounded-md bg-white/10 p-1.5 text-white/70 hover:bg-white/20 hover:text-white transition-colors"
                aria-label="Copy example"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(curlExample);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch {
                    // clipboard blocked — ignore
                  }
                }}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>

            <h3 className="mb-3 mt-5 flex items-center gap-2 text-[13px] font-bold">
              <Terminal className="h-3.5 w-3.5 text-muted-foreground" /> Example: list visits by
              phone
            </h3>
            <div className="rounded-lg bg-zinc-950 p-3.5 font-mono text-[11.5px] leading-relaxed text-zinc-200 overflow-x-auto">
              <pre className="whitespace-pre">{curlVisit}</pre>
            </div>
          </div>

          <div className="p-5">
            <h3 className="mb-3 text-[13px] font-bold">Endpoints</h3>
            <div className="space-y-2.5">
              {ENDPOINTS.map((e) => (
                <div key={`${e.method}-${e.path}`} className="rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    {methodBadge(e.method)}
                    <code className="font-mono text-[12px] font-semibold">{e.path}</code>
                    <Badge
                      variant="outline"
                      className="ml-auto text-[10px] px-1.5 font-mono shrink-0"
                    >
                      {e.scope}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-[12px] text-muted-foreground">{e.description}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Give the key a name so you remember where it is used, e.g. "POS terminal" or "Booking
              engine".
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <label htmlFor="api-key-name" className="text-[13px] font-medium">
                Key name
              </label>
              <Input
                id="api-key-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="POS terminal"
                maxLength={60}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-[13px] font-medium">Write access</p>
                <p className="text-[11.5px] text-muted-foreground">
                  Allow this key to create customers and record visits (not just read).
                </p>
              </div>
              <Switch
                checked={newWrite}
                onCheckedChange={setNewWrite}
                aria-label="Toggle write access"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newName.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              Create key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Secret shown once */}
      <Dialog open={!!createdSecret} onOpenChange={(open) => !open && setCreatedSecret(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" /> Your new API key
            </DialogTitle>
            <DialogDescription>
              Copy it now —{" "}
              <span className="font-semibold">this is the only time the full key is shown</span>.
              Only a secure hash is stored, so nobody (not even us) can recover it later.
            </DialogDescription>
          </DialogHeader>
          <div className="relative rounded-lg bg-zinc-950 p-4 font-mono text-[13px] text-emerald-300 break-all">
            {createdSecret}
          </div>
          <DialogFooter>
            <Button
              onClick={async () => {
                if (createdSecret) {
                  try {
                    await navigator.clipboard.writeText(createdSecret);
                    toast({ title: "Copied", description: "API key copied to clipboard." });
                  } catch {
                    // clipboard blocked
                  }
                }
              }}
            >
              <Copy className="h-4 w-4" /> Copy key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

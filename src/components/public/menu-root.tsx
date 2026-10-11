"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { PublicMenuClient } from "@/components/public/menu-client";

/**
 * Phase 12/13 — client root for the public menu page.
 *
 * The public tree does NOT share the admin app's <Providers> — this component
 * carries its own minimal QueryClientProvider (no auth context, no shared
 * cache with the admin app).
 */
export function PublicMenuRoot({ code }: { code: string }) {
  // One client per browser session (never re-created on re-renders).
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15_000 },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <PublicMenuClient code={code} />
    </QueryClientProvider>
  );
}

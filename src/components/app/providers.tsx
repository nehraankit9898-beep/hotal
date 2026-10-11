"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useCspNonce } from "@/components/app/csp-nonce";

export function Providers({ children }: { children: React.ReactNode }) {
  const nonce = useCspNonce();
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} nonce={nonce}>
        {children}
      </ThemeProvider>
    </QueryClientProvider>
  );
}

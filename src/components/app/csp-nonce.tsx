"use client";

import { createContext, useContext } from "react";

/**
 * Carries the per-request CSP nonce (set by src/proxy.ts, read in the root layout)
 * down to client components that render their own inline <script> tags —
 * currently the next-themes bootstrap inside <Providers>.
 */
const CspNonceContext = createContext<string | undefined>(undefined);

export function CspNonceProvider({
  nonce,
  children,
}: {
  nonce?: string;
  children: React.ReactNode;
}) {
  return <CspNonceContext.Provider value={nonce}>{children}</CspNonceContext.Provider>;
}

export function useCspNonce(): string | undefined {
  return useContext(CspNonceContext);
}

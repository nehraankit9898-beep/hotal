"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Providers } from "@/components/app/providers";
import { ActivateScreen } from "@/components/app/activate-screen";

/**
 * Bug fix — owner invitations previously emailed links to /activate?token=…
 * but only the SPA at "/" ever checked window.location.pathname, so the link
 * 404'd. This standalone route renders the activation flow directly; after a
 * successful activation the user is sent to "/" to sign in.
 */
function ActivateInner() {
  const queryClient = useQueryClient();
  const token = useSearchParams().get("token");

  if (!token) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <p className="text-lg font-bold">Invalid invitation link</p>
        <p className="text-sm text-muted-foreground max-w-sm">
          This activation link is missing its token. Ask your hotel owner to resend the invitation.
        </p>
        <a
          href="/"
          className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
        >
          Go to sign in
        </a>
      </div>
    );
  }

  return (
    <ActivateScreen
      token={token}
      onActivated={() => {
        queryClient.clear();
        window.location.replace("/");
      }}
    />
  );
}

export default function Page() {
  return (
    <Providers>
      <Suspense
        fallback={
          <div className="min-h-screen flex items-center justify-center bg-background">
            <p className="text-sm text-muted-foreground">Loading…</p>
          </div>
        }
      >
        <ActivateInner />
      </Suspense>
    </Providers>
  );
}

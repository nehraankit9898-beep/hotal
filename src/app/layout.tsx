import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { headers } from "next/headers";
import { Toaster } from "@/components/ui/toaster";
import { CspNonceProvider } from "@/components/app/csp-nonce";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "RestroLoop — Restaurant CRM, Loyalty & QR Ordering",
  description:
    "Turn one-time guests into repeat customers. Track visits, record marketing consent, and understand your loyal guests — built for hotels.",
  keywords: ["hotel", "customer retention", "loyalty", "visits", "hospitality"],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#b45309",
};

/**
 * SECURITY FIX (CSP nonce): the nonce is generated per request in src/proxy.ts.
 * Statically prerendered HTML cannot carry it, so every page must render per
 * request — reading headers() below opts the whole tree into dynamic rendering.
 */
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <CspNonceProvider nonce={nonce}>
          {children}
          <Toaster />
        </CspNonceProvider>
      </body>
    </html>
  );
}
